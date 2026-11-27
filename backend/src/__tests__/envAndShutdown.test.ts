import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { config } from '../config/env';
import { gracefulShutdown } from '../server';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    $disconnect: jest.fn().mockResolvedValue(undefined),
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

describe('Backend Fail-Fast Environment Validation & Graceful Shutdown', () => {
  it('should load typed immutable config object', () => {
    expect(config).toBeDefined();
    expect(config.PORT).toBeDefined();
    expect(typeof config.PORT).toBe('number');
  });

  it('should freeze config object preventing mutations', () => {
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('should default NODE_ENV to test in test execution context', () => {
    expect(config.NODE_ENV).toBe('test');
  });

  it('should provide default LiveKit configuration parameters', () => {
    expect(config.LIVEKIT_URL).toBeDefined();
    expect(config.LIVEKIT_API_KEY).toBeDefined();
    expect(config.LIVEKIT_API_SECRET).toBeDefined();
  });

  it('should provide robust JWT and JWT_REFRESH_SECRET configuration', () => {
    expect(config.JWT_SECRET).toBeDefined();
    expect(config.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(config.JWT_REFRESH_SECRET).toBeDefined();
    expect(config.JWT_REFRESH_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('should provide storage driver and bucket parameters aligned with production template', () => {
    expect(config.STORAGE_DRIVER).toBeDefined();
    expect(['local', 's3']).toContain(config.STORAGE_DRIVER);
    expect(config.AWS_BUCKET_NAME).toBeDefined();
  });

  it('should configure PgBouncer pool defaults on DATABASE_URL without mutating DIRECT_URL', () => {
    const pooledUrl = new URL(config.DATABASE_URL);
    expect(pooledUrl.searchParams.get('pgbouncer')).toBe('true');
    expect(pooledUrl.searchParams.get('connection_limit')).toBe('20');
    expect(pooledUrl.searchParams.get('pool_timeout')).toBe('15');
    expect(pooledUrl.searchParams.get('statement_cache_size')).toBe('0');
    expect(config.DB_POOL_LIMIT).toBe(20);
    expect(config.DB_POOL_TIMEOUT).toBe(15);
    expect(config.DISCONNECT_DEBOUNCE_MS).toBe(5000);

    if (config.DIRECT_URL) {
      const directUrl = new URL(config.DIRECT_URL);
      expect(directUrl.searchParams.has('pgbouncer')).toBe(false);
      expect(directUrl.searchParams.has('connection_limit')).toBe(false);
    }
  });

  it('should honor DB_POOL_LIMIT, DATABASE_CONNECTION_LIMIT, DB_POOL_TIMEOUT, DISCONNECT_DEBOUNCE_MS, and unpooled DIRECT_URL fallback', () => {
    const savedEnv = { ...process.env };
    try {
      jest.resetModules();
      process.env.DATABASE_URL = 'postgresql://postgres:pass@localhost:5432/huellicam_test?schema=public';
      process.env.DIRECT_URL = '';
      process.env.DB_POOL_LIMIT = '35';
      process.env.DB_POOL_TIMEOUT = '30';
      process.env.DISCONNECT_DEBOUNCE_MS = '2500';

      const { config: reloaded1 } = require('../config/env');
      const parsed1 = new URL(reloaded1.DATABASE_URL);
      expect(parsed1.searchParams.get('connection_limit')).toBe('35');
      expect(parsed1.searchParams.get('pool_timeout')).toBe('30');
      expect(parsed1.searchParams.get('pgbouncer')).toBe('true');
      expect(reloaded1.DB_POOL_LIMIT).toBe(35);
      expect(reloaded1.DB_POOL_TIMEOUT).toBe(30);
      expect(reloaded1.DISCONNECT_DEBOUNCE_MS).toBe(2500);
      expect(reloaded1.DIRECT_URL).toBe(
        'postgresql://postgres:pass@localhost:5432/huellicam_test?schema=public'
      );

      jest.resetModules();
      process.env.DATABASE_URL = 'postgresql://postgres:pass@localhost:5432/huellicam_test?schema=public';
      delete process.env.DB_POOL_LIMIT;
      process.env.DATABASE_CONNECTION_LIMIT = '25';
      delete process.env.DB_POOL_TIMEOUT;

      const { config: reloaded2 } = require('../config/env');
      const parsed2 = new URL(reloaded2.DATABASE_URL);
      expect(parsed2.searchParams.get('connection_limit')).toBe('25');
      expect(reloaded2.DB_POOL_LIMIT).toBe(25);
    } finally {
      process.env = savedEnv;
      jest.resetModules();
    }
  });

  it('should sanitize invalid pool query params and strip pooled params in DIRECT_URL fallback', () => {
    const savedEnv = { ...process.env };
    try {
      jest.resetModules();
      process.env.DATABASE_URL =
        'postgresql://postgres:pass@pooler.supabase.com:6543/app?schema=public&pgbouncer=true&statement_cache_size=0&connection_limit=0&pool_timeout=-1';
      process.env.DIRECT_URL = '';
      delete process.env.DB_POOL_LIMIT;
      delete process.env.DATABASE_CONNECTION_LIMIT;
      delete process.env.DB_POOL_TIMEOUT;

      const { config: reloaded } = require('../config/env');
      const pooled = new URL(reloaded.DATABASE_URL);
      expect(pooled.searchParams.get('connection_limit')).toBe('20');
      expect(pooled.searchParams.get('pool_timeout')).toBe('15');
      expect(pooled.searchParams.get('pgbouncer')).toBe('true');
      expect(pooled.searchParams.get('statement_cache_size')).toBe('0');
      expect(reloaded.DB_POOL_LIMIT).toBe(20);
      expect(reloaded.DB_POOL_TIMEOUT).toBe(15);

      const direct = new URL(reloaded.DIRECT_URL);
      expect(direct.searchParams.get('schema')).toBe('public');
      expect(direct.searchParams.has('pgbouncer')).toBe(false);
      expect(direct.searchParams.has('statement_cache_size')).toBe(false);
    } finally {
      process.env = savedEnv;
      jest.resetModules();
    }
  });

  it('should forward pool env vars in NODE_ENV=test fallback branch when schema validation fails', () => {
    const savedEnv = { ...process.env };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      jest.resetModules();
      process.env.NODE_ENV = 'test';
      process.env.JWT_SECRET = 'too-short';
      process.env.DATABASE_URL = 'postgresql://postgres:pass@localhost:5432/huellicam_test?schema=public';
      process.env.DB_POOL_LIMIT = '42';
      process.env.DB_POOL_TIMEOUT = '28';

      const { config: reloaded } = require('../config/env');
      const pooled = new URL(reloaded.DATABASE_URL);
      expect(pooled.searchParams.get('connection_limit')).toBe('42');
      expect(pooled.searchParams.get('pool_timeout')).toBe('28');
      expect(reloaded.DB_POOL_LIMIT).toBe(42);
      expect(reloaded.DB_POOL_TIMEOUT).toBe(28);
    } finally {
      errorSpy.mockRestore();
      process.env = savedEnv;
      jest.resetModules();
    }
  });

  it('should clear vetDisconnectTracker and disconnect Prisma during gracefulShutdown', async () => {
    const savedEnv = { ...process.env };
    try {
      jest.resetModules();
      process.env.NODE_ENV = 'test';
      process.env.PORT = '0';
      process.env.REDIS_URL = '';

      const reloadedPrisma = require('../lib/prisma').default;
      const { vetDisconnectTracker: reloadedTracker } = require('../realtime/vetDisconnectTracker');
      const clearSpy = jest.spyOn(reloadedTracker, 'clear');

      const serverModule = require('../server');
      const httpServer = serverModule.default;
      if (!httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.once('listening', resolve));
      }

      await serverModule.gracefulShutdown('SIGTERM');

      expect(clearSpy).toHaveBeenCalled();
      expect(reloadedPrisma.$disconnect).toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      process.env = savedEnv;
      jest.resetModules();
    }
  });

  it('should complete gracefulShutdown in < 2000ms with an actively connected Socket.io websocket client', async () => {
    const savedEnv = { ...process.env };
    let clientSocket: ClientSocket | undefined;
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      jest.resetModules();
      process.env.NODE_ENV = 'test';
      process.env.PORT = '0';
      process.env.REDIS_URL = '';

      const { config: reloadedConfig } = require('../config/env');
      const reloadedPrisma = require('../lib/prisma').default;
      reloadedPrisma.user.findUnique.mockResolvedValue({
        id: 'tutor-active-1',
        email: 'tutor-active@huellicam.com',
        firstName: 'Tutor',
        lastName: 'Active',
        role: 'CLIENT',
        tokenVersion: 1,
        vetStatus: null,
        deletedAt: null,
      });

      const serverModule = require('../server');
      const httpServer = serverModule.default;
      if (!httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.once('listening', resolve));
      }
      const port = (httpServer.address() as AddressInfo).port;

      const token = jwt.sign(
        { userId: 'tutor-active-1', role: 'CLIENT', tokenVersion: 1 },
        reloadedConfig.JWT_SECRET,
        { algorithm: 'HS256' }
      );

      clientSocket = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${token}`, deviceId: 'dev-active-1' },
          transports: ['websocket'],
          reconnection: false,
        });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      expect(clientSocket.connected).toBe(true);

      const startedAt = Date.now();
      await serverModule.gracefulShutdown('SIGTERM');
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(2000);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(reloadedPrisma.$disconnect).toHaveBeenCalled();
      expect(httpServer.listening).toBe(false);
    } finally {
      if (clientSocket) {
        clientSocket.disconnect();
        clientSocket.close();
      }
      exitSpy.mockRestore();
      process.env = savedEnv;
      jest.resetModules();
    }
  });

  it('should execute gracefulShutdown cleanly on SIGTERM signal without throwing', async () => {
    await expect(gracefulShutdown('SIGTERM')).resolves.not.toThrow();
  });

  it('should handle idempotent consecutive calls to gracefulShutdown', async () => {
    await expect(gracefulShutdown('SIGINT')).resolves.not.toThrow();
  });
});
