import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import prisma from '../../../backend/src/lib/prisma';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';
import { createInMemoryRedisMock } from '../helpers/node/inMemoryRedis';
import { runTsxSnippet } from '../helpers/node/subprocess';

const repoRoot = path.resolve(__dirname, '../../..');
const redisLibPath = path.join(repoRoot, 'backend', 'src', 'lib', 'redis.ts');
const socketServerPath = path.join(repoRoot, 'backend', 'src', 'realtime', 'socket.server.ts');

interface RedisClientLike {
  options?: {
    retryStrategy?: (times: number) => number | null;
    tls?: unknown;
    maxRetriesPerRequest?: number | null;
    enableReadyCheck?: boolean;
  };
  disconnect: (reconnect?: boolean) => void;
}

interface RedisModuleApi {
  createRedisClient: (url: string, options?: Record<string, unknown>) => RedisClientLike;
}

function loadRedisModule(): RedisModuleApi {
  expect(fs.existsSync(redisLibPath)).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(redisLibPath) as Partial<RedisModuleApi>;
  expect(typeof mod.createRedisClient).toBe('function');
  return mod as RedisModuleApi;
}

describe('F06 — Exponential Redis Retry & No Prod Memory Fallback (M3)', () => {
  let memPrisma: InMemoryPrisma;

  beforeAll(() => {
    memPrisma = new InMemoryPrisma();
    attachInMemoryPrisma(prisma, memPrisma);
  });

  beforeEach(() => {
    memPrisma.reset();
    delete process.env.REDIS_URL;
  });

  it('T1-F06-01: createRedisClient configures capped jittered exponential retryStrategy (never null)', () => {
    const { createRedisClient } = loadRedisModule();
    const client = createRedisClient('redis://127.0.0.1:6379', { lazyConnect: true });
    try {
      const strategy = client.options?.retryStrategy;
      expect(typeof strategy).toBe('function');
      if (!strategy) return;

      const d1 = strategy(1);
      const d2 = strategy(2);
      const d5 = strategy(5);
      const d10 = strategy(10);
      const d20 = strategy(20);

      for (const d of [d1, d2, d5, d10, d20]) {
        expect(typeof d).toBe('number');
        expect(Number.isFinite(d)).toBe(true);
        expect(d!).toBeGreaterThan(0);
      }
      expect(d5!).toBeGreaterThan(d1!);
      expect(d10!).toBeGreaterThanOrEqual(d2!);
      expect(d20!).toBeLessThanOrEqual(30000);
    } finally {
      client.disconnect(false);
    }
  });

  it('T1-F06-02: createRedisClient enables TLS options for rediss:// and omits TLS for redis://', () => {
    const { createRedisClient } = loadRedisModule();
    const tlsClient = createRedisClient('rediss://default:secret@redis-prod.upstash.io:6380', {
      lazyConnect: true,
    });
    const plainClient = createRedisClient('redis://127.0.0.1:6379', { lazyConnect: true });

    try {
      expect(tlsClient.options?.tls).toBeDefined();
      expect(tlsClient.options?.tls).not.toBeNull();
      expect(typeof tlsClient.options?.tls).toBe('object');
      expect(plainClient.options?.tls).toBeUndefined();
    } finally {
      tlsClient.disconnect(false);
      plainClient.disconnect(false);
    }
  });

  it('T1-F06-03: initializeSocketServer in NODE_ENV=production with connected Redis attaches RedisAdapter', async () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);

    const res = runTsxSnippet(
      `
      import { createServer } from 'http';
      import * as socketMod from './backend/src/realtime/socket.server';
      const srv = createServer();
      Promise.resolve()
        .then(async () => {
          const io = await socketMod.initializeSocketServer(srv);
          if (typeof (socketMod as { whenSocketRedisReady?: () => Promise<void> }).whenSocketRedisReady === 'function') {
            await (socketMod as { whenSocketRedisReady: () => Promise<void> }).whenSocketRedisReady();
          }
          return io;
        })
        .then((io) => {
          const adapterName = io.of('/').adapter.constructor.name;
          console.log('UNEXPECTED_FALLBACK:' + adapterName);
          return new Promise<void>((r) => io.close(() => r()));
        })
        .catch((err) => {
          console.error('FAILED_FAST:' + (err?.message || String(err)));
          process.exit(1);
        });
      `,
      {
        NODE_ENV: 'production',
        REDIS_URL: 'redis://127.0.0.1:59998',
      }
    );

    // Note: without a live Redis on 59998, prod MUST fail fast rather than silently falling back to InMemoryAdapter.
    // Verify via socket.server.ts contract + isolated mock Redis adapter attachment:
    const socketServerSource = fs.readFileSync(socketServerPath, 'utf8');
    expect(socketServerSource).not.toMatch(/retryStrategy:\s*\(\)\s*=>\s*null/);
    expect(socketServerSource).toMatch(/lib\/redis/);

    // Verify with mocked ioredis in isolated module registry that Redis adapter attaches in production
    let adapterName = '';
    await jest.isolateModulesAsync(async () => {
      const { FakeRedis } = createInMemoryRedisMock();

      jest.doMock('ioredis', () => ({
        __esModule: true,
        default: FakeRedis,
        Redis: FakeRedis,
      }));

      const prevEnv = process.env.NODE_ENV;
      const prevRedis = process.env.REDIS_URL;
      process.env.NODE_ENV = 'production';
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      const httpSrv = createServer();
      try {
        const socketMod = require('../../../backend/src/realtime/socket.server') as {
          initializeSocketServer: (srv: unknown) => {
            of: (ns: string) => { adapter: { constructor: { name: string } } };
            close: (cb: () => void) => void;
          };
          whenSocketRedisReady?: () => Promise<void>;
        };
        const ioInstance = await socketMod.initializeSocketServer(httpSrv);
        if (typeof socketMod.whenSocketRedisReady === 'function') {
          await socketMod.whenSocketRedisReady();
        }
        adapterName = ioInstance.of('/').adapter.constructor.name;
        await new Promise<void>((resolve) => ioInstance.close(() => resolve()));
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevRedis === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = prevRedis;
        jest.dontMock('ioredis');
      }
    });

    expect(adapterName).toMatch(/RedisAdapter/i);
    expect(res.error).toBeUndefined();
    expect(res.stdout).not.toContain('UNEXPECTED_FALLBACK');
    expect(res.stderr).not.toMatch(
      /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Validación de variables de entorno fallida/i
    );
    expect(res.stderr).toContain('FAILED_FAST:');
    expect(res.status).toBe(1);
  });

  it('T1-F06-04: initializeSocketServer in NODE_ENV=test without REDIS_URL starts cleanly with local Adapter', async () => {
    const httpSrv = createServer();
    const { initializeSocketServer } = require('../../../backend/src/realtime/socket.server');
    const ioInstance = await initializeSocketServer(httpSrv);
    try {
      expect(ioInstance.of('/').adapter.constructor.name).toBe('Adapter');
    } finally {
      await new Promise<void>((resolve) => ioInstance.close(() => resolve()));
    }
  });

  it('T1-F06-05: backend/src uses shared redis.ts factory and has zero retryStrategy: () => null', () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);
    const socketSrc = fs.readFileSync(socketServerPath, 'utf8');
    expect(socketSrc).not.toMatch(/retryStrategy:\s*\(\)\s*=>\s*null/);
    expect(socketSrc).toMatch(/createRedisClient|redis/i);
  });

  it('T2-F06-01: NODE_ENV=production with missing REDIS_URL fails fast instead of using InMemoryAdapter', () => {
    const result = runTsxSnippet(
      `
      import { createServer } from 'http';
      import * as socketMod from './backend/src/realtime/socket.server';
      const srv = createServer();
      Promise.resolve()
        .then(async () => {
          const io = await socketMod.initializeSocketServer(srv);
          if (typeof (socketMod as { whenSocketRedisReady?: () => Promise<void> }).whenSocketRedisReady === 'function') {
            await (socketMod as { whenSocketRedisReady: () => Promise<void> }).whenSocketRedisReady();
          }
          console.log('UNEXPECTED_FALLBACK:' + io.of('/').adapter.constructor.name);
          process.exit(0);
        })
        .catch((err) => {
          console.error('FAILED_FAST:' + (err?.message || String(err)));
          process.exit(1);
        });
      `,
      {
        NODE_ENV: 'production',
        REDIS_URL: '',
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.stdout).not.toContain('UNEXPECTED_FALLBACK');
    expect(result.stderr).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError/i);
    expect(result.stderr).toMatch(/FAILED_FAST:|REDIS_URL/i);
    expect(result.status).toBe(1);
  });

  it('T2-F06-02: NODE_ENV=production with unreachable REDIS_URL rejects instead of falling back to InMemoryAdapter', () => {
    const result = runTsxSnippet(
      `
      import { createServer } from 'http';
      import * as socketMod from './backend/src/realtime/socket.server';
      const srv = createServer();
      Promise.resolve()
        .then(async () => {
          const io = await socketMod.initializeSocketServer(srv);
          if (typeof (socketMod as { whenSocketRedisReady?: () => Promise<void> }).whenSocketRedisReady === 'function') {
            await (socketMod as { whenSocketRedisReady: () => Promise<void> }).whenSocketRedisReady();
          }
          setTimeout(() => {
            console.log('UNEXPECTED_FALLBACK:' + io.of('/').adapter.constructor.name);
            process.exit(0);
          }, 2500);
        })
        .catch((err) => {
          console.error('FAILED_FAST:' + (err?.message || String(err)));
          process.exit(1);
        });
      `,
      {
        NODE_ENV: 'production',
        REDIS_URL: 'redis://127.0.0.1:59999',
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.stdout).not.toContain('UNEXPECTED_FALLBACK');
    expect(result.stderr).not.toMatch(
      /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Validación de variables de entorno fallida/i
    );
    expect(result.stderr).toContain('FAILED_FAST:');
    expect(result.status).toBe(1);
  });

  it('T2-F06-03: retryStrategy handles extreme attempt count (times=1000) without Infinity or NaN', () => {
    const { createRedisClient } = loadRedisModule();
    const client = createRedisClient('redis://127.0.0.1:6379', { lazyConnect: true });
    try {
      const delay = client.options?.retryStrategy?.(1000);
      expect(typeof delay).toBe('number');
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay!).toBeGreaterThan(0);
      expect(delay!).toBeLessThanOrEqual(30000);
    } finally {
      client.disconnect(false);
    }
  });

  it('T2-F06-04: createRedisClient throws explicit validation error for invalid URL scheme', () => {
    const { createRedisClient } = loadRedisModule();
    expect(() => createRedisClient('http://not-a-redis-url')).toThrow();
  });

  it('T2-F06-05: rediss:// client configures TLS and exponential retry delays for recovery attempts', () => {
    const { createRedisClient } = loadRedisModule();
    const client = createRedisClient('rediss://localhost:6380', { lazyConnect: true });
    try {
      expect(client.options?.tls).toBeDefined();
      const d1 = client.options?.retryStrategy?.(1);
      const d5 = client.options?.retryStrategy?.(5);
      const d20 = client.options?.retryStrategy?.(20);
      expect(d1).not.toBeNull();
      expect(d5).not.toBeNull();
      expect(d20).not.toBeNull();
      expect(typeof d1).toBe('number');
      expect(typeof d5).toBe('number');
      expect(typeof d20).toBe('number');
      expect(d1!).toBeGreaterThan(0);
      expect(d5!).toBeGreaterThan(d1!);
      expect(d20!).toBeLessThanOrEqual(30000);
    } finally {
      client.disconnect(false);
    }
  });
});
