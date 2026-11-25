import { createServer, Server as HttpServer } from 'http';
import { AddressInfo, createServer as createTcpServer, Server as TcpServer } from 'net';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import {
  buildRedisOptions,
  closeAllRedisClients,
  closeRedisClient,
  createRedisClient,
  createRedisRetryStrategy,
  getTrackedRedisClientCount,
  isValidRedisUrl,
  normalizeRedisUrl,
} from '../lib/redis';

describe('Redis Client, Retry Strategy, TLS & Production Fail-Fast (M3)', () => {
  describe('normalizeRedisUrl & isValidRedisUrl', () => {
    it('normalizes whitespace/quotes and treats empty or "undefined"/"null" strings as undefined', () => {
      expect(normalizeRedisUrl(undefined)).toBeUndefined();
      expect(normalizeRedisUrl(null)).toBeUndefined();
      expect(normalizeRedisUrl('')).toBeUndefined();
      expect(normalizeRedisUrl('   ')).toBeUndefined();
      expect(normalizeRedisUrl('undefined')).toBeUndefined();
      expect(normalizeRedisUrl('"undefined"')).toBeUndefined();
      expect(normalizeRedisUrl("'null'")).toBeUndefined();
      expect(normalizeRedisUrl('  "rediss://default:secret@redis.upstash.io:6379"  ')).toBe(
        'rediss://default:secret@redis.upstash.io:6379'
      );
    });

    it('validates only redis: and rediss: URL schemes', () => {
      expect(isValidRedisUrl('redis://localhost:6379')).toBe(true);
      expect(isValidRedisUrl('rediss://user:pass@cache.example.com:6380')).toBe(true);
      expect(isValidRedisUrl('http://localhost:6379')).toBe(false);
      expect(isValidRedisUrl('not-a-url')).toBe(false);
    });
  });

  describe('createRedisRetryStrategy', () => {
    it('computes exponential backoff capped at 10_000ms', () => {
      const strategy = createRedisRetryStrategy({ jitterMs: 0 });
      expect(strategy(1)).toBe(100);
      expect(strategy(2)).toBe(200);
      expect(strategy(3)).toBe(400);
      expect(strategy(4)).toBe(800);
      expect(strategy(5)).toBe(1600);
      expect(strategy(8)).toBe(10_000);
      expect(strategy(15)).toBe(10_000);
    });

    it('adds bounded jitter when jitterMs > 0 and stops when maxRetries is exceeded', () => {
      const strategy = createRedisRetryStrategy({
        baseDelayMs: 100,
        maxDelayMs: 500,
        jitterMs: 50,
        maxRetries: 3,
      });

      const d1 = strategy(1);
      const d2 = strategy(2);
      const d3 = strategy(3);
      expect(d1).toBeGreaterThanOrEqual(100);
      expect(d1).toBeLessThan(150);
      expect(d2).toBeGreaterThanOrEqual(200);
      expect(d2).toBeLessThan(250);
      expect(d3).toBeGreaterThanOrEqual(400);
      expect(d3).toBeLessThan(450);
      expect(strategy(4)).toBeNull();
    });

    it('never exceeds maxDelayMs (10_000ms) at attempts 8..10 with default jitter', () => {
      const strategy = createRedisRetryStrategy();
      for (const attempt of [8, 9, 10]) {
        for (let i = 0; i < 500; i++) {
          const delay = strategy(attempt);
          expect(delay).not.toBeNull();
          expect(delay!).toBeLessThanOrEqual(10_000);
          expect(delay!).toBeGreaterThanOrEqual(10_000);
        }
      }
    });
  });

  describe('buildRedisOptions', () => {
    it('configures explicit tls ConnectionOptions for rediss:// hostnames and IPv4/IPv6 literals', () => {
      const hostOpts = buildRedisOptions('rediss://default:pass@upstash.example.com:6379');
      expect(hostOpts.tls).toEqual({ servername: 'upstash.example.com' });
      expect(hostOpts.lazyConnect).toBe(true);
      expect(hostOpts.connectTimeout).toBe(5000);
      expect(hostOpts.enableOfflineQueue).toBe(true);
      expect(hostOpts.maxRetriesPerRequest).toBe(3);
      expect(typeof hostOpts.retryStrategy).toBe('function');

      const ipv4Opts = buildRedisOptions('rediss://127.0.0.1:6380');
      expect(ipv4Opts.tls).toEqual({});

      const ipv6Opts = buildRedisOptions('rediss://[::1]:6379');
      expect(ipv6Opts.tls).toEqual({});

      const ipv6FullOpts = buildRedisOptions('rediss://[2001:db8::1]:6380');
      expect(ipv6FullOpts.tls).toEqual({});
    });

    it('omits tls for plain redis:// URLs and throws on invalid URLs', () => {
      const plainOpts = buildRedisOptions('redis://127.0.0.1:6379');
      expect(plainOpts.tls).toBeUndefined();
      expect(() => buildRedisOptions('https://localhost:6379')).toThrow(/Invalid REDIS_URL/);
    });
  });

  describe('env.ts REDIS_URL validation', () => {
    it('rejects missing or invalid REDIS_URL when NODE_ENV === production', () => {
      const savedEnv = { ...process.env };
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        jest.resetModules();
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgresql://postgres:pass@db.example.com:5432/app';
        process.env.JWT_SECRET = 'prod-jwt-secret-key-min-32-chars-long-12345';
        process.env.JWT_REFRESH_SECRET = 'prod-refresh-secret-key-min-32-chars-long-12345';
        process.env.LIVEKIT_URL = 'wss://livekit.example.com';
        process.env.LIVEKIT_API_KEY = 'lk_key';
        process.env.LIVEKIT_API_SECRET = 'lk_secret';
        process.env.REDIS_URL = '';

        require('../config/env');
        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockClear();
        jest.resetModules();
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = 'http://invalid-scheme:6379';
        require('../config/env');
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        exitSpy.mockRestore();
        errSpy.mockRestore();
        process.env = savedEnv;
        jest.resetModules();
      }
    });

    it('accepts quoted rediss:// REDIS_URL in production and normalizes empty REDIS_URL in test/dev', () => {
      const savedEnv = { ...process.env };
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        jest.resetModules();
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgresql://postgres:pass@db.example.com:5432/app';
        process.env.JWT_SECRET = 'prod-jwt-secret-key-min-32-chars-long-12345';
        process.env.JWT_REFRESH_SECRET = 'prod-refresh-secret-key-min-32-chars-long-12345';
        process.env.LIVEKIT_URL = 'wss://livekit.example.com';
        process.env.LIVEKIT_API_KEY = 'lk_key';
        process.env.LIVEKIT_API_SECRET = 'lk_secret';
        process.env.REDIS_URL = '  "rediss://default:secret@cache.example.com:6379"  ';

        const { config: prodConfig } = require('../config/env');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(prodConfig.REDIS_URL).toBe('rediss://default:secret@cache.example.com:6379');

        jest.resetModules();
        process.env.NODE_ENV = 'test';
        process.env.REDIS_URL = '   ';
        const { config: testConfig } = require('../config/env');
        expect(testConfig.REDIS_URL).toBeUndefined();
      } finally {
        exitSpy.mockRestore();
        errSpy.mockRestore();
        process.env = savedEnv;
        jest.resetModules();
      }
    });
  });

  describe('socket.server.ts production fail-fast & test fallback', () => {
    it('throws synchronously in production when REDIS_URL is missing (no InMemoryAdapter fallback)', () => {
      const savedEnv = { ...process.env };
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const httpServer = createServer();

      try {
        process.env.NODE_ENV = 'production';
        process.env.REDIS_URL = '';

        jest.resetModules();
        const { initializeSocketServer } = require('../realtime/socket.server');
        expect(() => initializeSocketServer(httpServer)).toThrow(/REDIS_URL is required in production/);
      } finally {
        httpServer.close();
        exitSpy.mockRestore();
        errSpy.mockRestore();
        process.env = savedEnv;
        jest.resetModules();
      }
    });

    it('rejects whenSocketRedisReady(), blocks InMemoryAdapter connections, and leaks 0 Redis clients when Redis is unreachable in production', async () => {
      const savedEnv = { ...process.env };
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      let httpServer: HttpServer | undefined;
      let clientSocket: ClientSocket | undefined;

      try {
        jest.resetModules();
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgresql://postgres:pass@db.example.com:5432/app';
        process.env.JWT_SECRET = 'prod-jwt-secret-key-min-32-chars-long-12345';
        process.env.JWT_REFRESH_SECRET = 'prod-refresh-secret-key-min-32-chars-long-12345';
        process.env.LIVEKIT_URL = 'wss://livekit.example.com';
        process.env.LIVEKIT_API_KEY = 'lk_key';
        process.env.LIVEKIT_API_SECRET = 'lk_secret';
        process.env.REDIS_URL = 'redis://127.0.0.1:63799';

        const {
          initializeSocketServer,
          whenSocketRedisReady,
        } = require('../realtime/socket.server');
        const { getTrackedRedisClientCount: getCount } = require('../lib/redis');

        httpServer = createServer();
        await new Promise<void>((resolve) => httpServer!.listen(() => resolve()));
        const port = (httpServer.address() as AddressInfo).port;

        const testIo = initializeSocketServer(httpServer);
        const readyAssertion = expect(whenSocketRedisReady()).rejects.toThrow();

        // Attempt a connection while adapter is not ready: must be rejected
        const connectErr = await new Promise<Error | null>((resolve) => {
          const s = Client(`http://localhost:${port}`, {
            auth: { token: 'Bearer any' },
            transports: ['websocket'],
            reconnection: false,
          });
          clientSocket = s;
          s.once('connect', () => resolve(null));
          s.once('connect_error', (err) => resolve(err));
        });
        expect(connectErr).toBeTruthy();

        await readyAssertion;
        expect(getCount()).toBe(0);
        testIo.close();
      } finally {
        clientSocket?.close();
        if (httpServer?.listening) {
          await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        }
        errSpy.mockRestore();
        process.env = savedEnv;
        jest.resetModules();
      }
    });

    it('gracefully falls back to InMemoryAdapter in test mode without leaking Redis probe clients', async () => {
      const savedEnv = { ...process.env };
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      let httpServer: HttpServer | undefined;

      try {
        jest.resetModules();
        process.env.NODE_ENV = 'test';
        process.env.REDIS_URL = 'redis://127.0.0.1:63799';

        const {
          initializeSocketServer,
          whenSocketRedisReady,
        } = require('../realtime/socket.server');
        const { getTrackedRedisClientCount: getCount } = require('../lib/redis');

        httpServer = createServer();
        const testIo = initializeSocketServer(httpServer);
        await expect(whenSocketRedisReady()).resolves.toBeUndefined();
        expect(getCount()).toBe(0);
        testIo.close();
      } finally {
        if (httpServer?.listening) {
          await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        }
        infoSpy.mockRestore();
        process.env = savedEnv;
        jest.resetModules();
      }
    });
  });

  describe('closeRedisClient & gracefulShutdown Redis cleanup', () => {
    it('calls quit() for ready clients and disconnect(false) for reconnecting/wait clients without hanging', async () => {
      const readyClient = {
        status: 'ready',
        quit: jest.fn().mockResolvedValue('OK'),
        disconnect: jest.fn(),
      } as any;
      await closeRedisClient(readyClient, 200);
      expect(readyClient.quit).toHaveBeenCalledTimes(1);

      const reconnectingClient = {
        status: 'reconnecting',
        quit: jest.fn(),
        disconnect: jest.fn(),
      } as any;
      await closeRedisClient(reconnectingClient, 200);
      expect(reconnectingClient.quit).not.toHaveBeenCalled();
      expect(reconnectingClient.disconnect).toHaveBeenCalledWith(false);

      // Verify real lazy client closes cleanly with 0 tracked clients remaining
      const realLazy = createRedisClient('redis://127.0.0.1:63799');
      expect(getTrackedRedisClientCount()).toBeGreaterThanOrEqual(1);
      await closeAllRedisClients(200);
      expect(getTrackedRedisClientCount()).toBe(0);
      expect(realLazy.status === 'end' || realLazy.status === 'wait' || realLazy.status === 'close').toBe(true);

      // Verify synchronous-throw quit() still runs disconnect(false) without rejecting
      const syncThrowClient = {
        status: 'ready',
        quit: jest.fn(() => {
          throw new Error('sync quit failure');
        }),
        disconnect: jest.fn(),
      } as any;
      await expect(closeRedisClient(syncThrowClient, 200)).resolves.toBeUndefined();
      expect(syncThrowClient.disconnect).toHaveBeenCalledWith(false);
    });

    it('handles 3x rapid initializeSocketServer re-init against delayed RESP server with 0 leaked clients and 0 unhandledRejections', async () => {
      const savedEnv = { ...process.env };
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      const respServer: TcpServer = createTcpServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          while (buffer.length > 0) {
            const firstCrLf = buffer.indexOf('\r\n');
            if (firstCrLf === -1) break;
            if (!buffer.startsWith('*')) {
              const cmd = buffer.slice(0, firstCrLf).trim().toUpperCase();
              buffer = buffer.slice(firstCrLf + 2);
              setTimeout(() => {
                if (socket.destroyed) return;
                if (cmd === 'PING') socket.write('+PONG\r\n');
                else socket.write('+OK\r\n');
              }, 30);
              continue;
            }
            const argCount = parseInt(buffer.slice(1, firstCrLf), 10);
            let cursor = firstCrLf + 2;
            const args: string[] = [];
            let incomplete = false;
            for (let i = 0; i < argCount; i++) {
              const lenEnd = buffer.indexOf('\r\n', cursor);
              if (lenEnd === -1) {
                incomplete = true;
                break;
              }
              const len = parseInt(buffer.slice(cursor + 1, lenEnd), 10);
              const valStart = lenEnd + 2;
              const valEnd = valStart + len;
              if (buffer.length < valEnd + 2) {
                incomplete = true;
                break;
              }
              args.push(buffer.slice(valStart, valEnd));
              cursor = valEnd + 2;
            }
            if (incomplete) break;
            buffer = buffer.slice(cursor);

            const cmd = (args[0] || '').toUpperCase();
            setTimeout(() => {
              if (socket.destroyed) return;
              if (cmd === 'PING') {
                socket.write('+PONG\r\n');
              } else if (cmd === 'INFO') {
                socket.write('$0\r\n\r\n');
              } else if (cmd === 'QUIT') {
                socket.write('+OK\r\n');
                socket.end();
              } else if (cmd === 'SUBSCRIBE' || cmd === 'PSUBSCRIBE') {
                const kind = cmd.toLowerCase();
                for (let idx = 1; idx < args.length; idx++) {
                  const ch = args[idx];
                  socket.write(
                    `*3\r\n$${kind.length}\r\n${kind}\r\n$${ch.length}\r\n${ch}\r\n:${idx}\r\n`
                  );
                }
              } else if (cmd === 'UNSUBSCRIBE' || cmd === 'PUNSUBSCRIBE') {
                const kind = cmd.toLowerCase();
                const ch = args[1] || '';
                socket.write(
                  `*3\r\n$${kind.length}\r\n${kind}\r\n$${ch.length}\r\n${ch}\r\n:0\r\n`
                );
              } else {
                socket.write('+OK\r\n');
              }
            }, 30);
          }
        });
      });

      let httpServer: HttpServer | undefined;
      let latestIo: any;

      try {
        await new Promise<void>((resolve) => respServer.listen(0, '127.0.0.1', resolve));
        const respPort = (respServer.address() as AddressInfo).port;

        jest.resetModules();
        process.env.NODE_ENV = 'test';
        process.env.REDIS_URL = `redis://127.0.0.1:${respPort}`;

        const {
          initializeSocketServer,
          whenSocketRedisReady,
        } = require('../realtime/socket.server');
        const {
          getRedisClient: getShared,
          getTrackedRedisClientCount: getCount,
          closeAllRedisClients: closeAll,
        } = require('../lib/redis');

        httpServer = createServer();
        initializeSocketServer(httpServer);
        initializeSocketServer(httpServer);
        latestIo = initializeSocketServer(httpServer);

        await whenSocketRedisReady();
        expect(getShared()).not.toBeNull();
        expect(getShared().status).toBe('ready');
        expect(getCount()).toBe(3);

        await closeAll(500);
        await new Promise((r) => setTimeout(r, 60));
        expect(getCount()).toBe(0);
        expect(unhandledRejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
        latestIo?.close();
        if (httpServer?.listening) {
          await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        }
        await new Promise<void>((resolve) => respServer.close(() => resolve()));
        logSpy.mockRestore();
        warnSpy.mockRestore();
        infoSpy.mockRestore();
        process.env = savedEnv;
        jest.resetModules();
      }
    });

    it('invokes closeAllRedisClients AFTER disconnectQueue.flushAll() and io.close() during gracefulShutdown', async () => {
      const savedEnv = { ...process.env };
      try {
        jest.resetModules();
        process.env.NODE_ENV = 'test';
        process.env.PORT = '0';
        process.env.REDIS_URL = '';

        const callOrder: string[] = [];

        jest.doMock('../lib/prisma', () => ({
          __esModule: true,
          default: {
            $disconnect: jest.fn(async () => {
              callOrder.push('prisma.disconnect');
            }),
            user: {
              findUnique: jest.fn(),
              update: jest.fn(),
            },
          },
        }));

        const { disconnectQueue } = require('../realtime/disconnectQueue');
        const flushSpy = jest
          .spyOn(disconnectQueue, 'flushAll')
          .mockImplementation(async () => {
            callOrder.push('disconnectQueue.flushAll');
          });
        const redisMod = require('../lib/redis');
        const closeRedisSpy = jest
          .spyOn(redisMod, 'closeAllRedisClients')
          .mockImplementation(async () => {
            callOrder.push('closeAllRedisClients');
          });

        const serverModule = require('../server');
        const httpServer = serverModule.default as HttpServer;
        if (!httpServer.listening) {
          await new Promise<void>((resolve) => httpServer.once('listening', resolve));
        }

        await serverModule.gracefulShutdown('SIGTERM');

        expect(callOrder).toEqual([
          'disconnectQueue.flushAll',
          'closeAllRedisClients',
          'prisma.disconnect',
        ]);

        flushSpy.mockRestore();
        closeRedisSpy.mockRestore();
      } finally {
        process.env = savedEnv;
        jest.resetModules();
      }
    });
  });
});
