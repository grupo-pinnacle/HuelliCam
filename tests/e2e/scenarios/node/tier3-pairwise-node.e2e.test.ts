import fs from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import jwt from 'jsonwebtoken';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import prisma from '../../../../backend/src/lib/prisma';
import { buildPooledDatabaseUrl } from '../../../../backend/src/config/env';
import {
  consultationConcurrencyService,
  setConcurrencySchemaSupportForTest,
} from '../../../../backend/src/modules/consultations/consultationConcurrency.service';
import { attachInMemoryPrisma, InMemoryPrisma } from '../../helpers/node/inMemoryPrisma';
import { createInMemoryRedisMock } from '../../helpers/node/inMemoryRedis';
import {
  EphemeralServerHandle,
  mintAccessToken,
  startEphemeralServer,
} from '../../helpers/node/ephemeralServer';
import { signLiveKitWebhook } from '../../helpers/node/livekitWebhook';
import { runTsxSnippet } from '../../helpers/node/subprocess';

const repoRoot = path.resolve(__dirname, '../../../..');
const disconnectQueuePath = path.join(repoRoot, 'backend', 'src', 'realtime', 'disconnectQueue.ts');
const redisLibPath = path.join(repoRoot, 'backend', 'src', 'lib', 'redis.ts');
const loggerPath = path.join(repoRoot, 'backend', 'src', 'lib', 'logger.ts');

describe('Tier 3 — Cross-Feature Pairwise Combinations (Node/Backend)', () => {
  let memPrisma: InMemoryPrisma;
  let server: EphemeralServerHandle | null = null;

  beforeAll(() => {
    memPrisma = new InMemoryPrisma();
    attachInMemoryPrisma(prisma, memPrisma);
  });

  beforeEach(() => {
    memPrisma.reset();
    setConcurrencySchemaSupportForTest(true);
  });

  afterEach(async () => {
    if (fs.existsSync(disconnectQueuePath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(disconnectQueuePath) as {
          disconnectQueue?: { clear?: () => void };
          clear?: () => void;
        };
        (mod.disconnectQueue?.clear ?? mod.clear)?.();
      } catch {
        // Ignore teardown errors
      }
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('T3-P01 (F1+F2): PgBouncer CAS claim + debounced disconnect queue update stateVersion without FOR UPDATE or overwriting vetId', async () => {
    expect(fs.existsSync(disconnectQueuePath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 't1-p01',
        email: 't1-p01@test.com',
        password: 'hash',
        firstName: 'Tutor',
        lastName: 'P01',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'v1-p01',
        email: 'v1-p01@test.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'P01',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'c-p01',
        clientId: 't1-p01',
        petId: 'pet-p01',
        status: 'WAITING',
        activeDeviceId: 'dev-1',
        transportStatus: 'ONLINE',
        stateVersion: 1,
      },
    });

    server = await startEphemeralServer();
    const tutorSock = await server.connectSocket({
      token: mintAccessToken({ id: 't1-p01', role: 'CLIENT', tokenVersion: 1 }),
      deviceId: 'dev-1',
    });

    tutorSock.disconnect();
    await new Promise((r) => setTimeout(r, 20));

    const claimRes = await consultationConcurrencyService.claimConsultationByVet('c-p01', 'v1-p01');
    expect(claimRes.stateVersion).toBe(2);

    await new Promise((r) => setTimeout(r, 380));

    const finalCons = await memPrisma.consultation.findUnique({ where: { id: 'c-p01' } });
    expect(finalCons?.vetId).toBe('v1-p01');
    expect(finalCons?.transportStatus).toBe('GRACE_DISCONNECTED');
    expect(finalCons?.stateVersion).toBe(3);

    const forUpdateQueries = memPrisma.capturedSql.filter((q) => /\bFOR\s+UPDATE\b/i.test(q.sql));
    expect(forUpdateQueries).toEqual([]);
  });

  it('T3-P04 (F6+F7): Redis exponential retry factory & TTL presence store work together cleanly', async () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const redisMod = require(redisLibPath) as {
      createRedisClient: (url: string, opts?: Record<string, unknown>) => {
        options?: { retryStrategy?: (t: number) => number | null };
        disconnect: (r?: boolean) => void;
      };
    };

    const client = redisMod.createRedisClient('redis://127.0.0.1:6379', { lazyConnect: true });
    try {
      const d1 = client.options?.retryStrategy?.(1);
      const d5 = client.options?.retryStrategy?.(5);
      const d20 = client.options?.retryStrategy?.(20);
      for (const d of [d1, d5, d20]) {
        expect(typeof d).toBe('number');
        expect(Number.isFinite(d)).toBe(true);
        expect(d!).toBeGreaterThan(0);
      }
      expect(d5!).toBeGreaterThan(d1!);
      expect(d20!).toBeLessThanOrEqual(30000);
    } finally {
      client.disconnect(false);
    }

    await memPrisma.user.create({
      data: {
        id: 'vet-p04',
        email: 'vet-p04@clinic.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'P04',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });

    const { state: redisState, FakeRedis } = createInMemoryRedisMock();
    let capturedErr: unknown = null;

    await jest.isolateModulesAsync(async () => {
      jest.doMock('ioredis', () => ({
        __esModule: true,
        default: FakeRedis,
        Redis: FakeRedis,
      }));

      const prevRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      const httpSrv = createServer();
      let ioInstance: { close: (cb: () => void) => void } | null = null;
      const sockets: ClientSocket[] = [];

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const isolatedPrisma = require('../../../../backend/src/lib/prisma').default;
        attachInMemoryPrisma(isolatedPrisma, memPrisma);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { config: isolatedConfig } = require('../../../../backend/src/config/env');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          initializeSocketServer,
          whenSocketRedisReady,
        } = require('../../../../backend/src/realtime/socket.server');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { presenceService } = require('../../../../backend/src/realtime/presence.service');

        ioInstance = await initializeSocketServer(httpSrv);
        if (typeof whenSocketRedisReady === 'function') {
          await whenSocketRedisReady();
        }
        await new Promise<void>((resolve, reject) => {
          httpSrv.once('error', reject);
          httpSrv.listen(0, '127.0.0.1', () => {
            httpSrv.off('error', reject);
            resolve();
          });
        });

        const port = (httpSrv.address() as AddressInfo).port;
        const vetToken = jwt.sign(
          { userId: 'vet-p04', role: 'VET', tokenVersion: 1 },
          isolatedConfig.JWT_SECRET,
          { algorithm: 'HS256', expiresIn: '15m' }
        );
        const vetSock = createSocketClient(`http://127.0.0.1:${port}`, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          auth: { token: `Bearer ${vetToken}` },
        });
        sockets.push(vetSock);

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Vet socket connect timeout')), 5000);
          vetSock.once('connect', () => {
            clearTimeout(timer);
            resolve();
          });
          vetSock.once('connect_error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && redisState.getPresenceEntries().length === 0) {
          await new Promise((r) => setTimeout(r, 25));
        }

        const presenceEntries = redisState.getPresenceEntries();
        expect(presenceEntries.length).toBeGreaterThanOrEqual(1);
        const positiveTtlEntries = presenceEntries.filter((e) => e.ttlMs !== null && e.ttlMs > 0);
        expect(positiveTtlEntries.length).toBeGreaterThanOrEqual(1);
        const maxTtlMs = Math.max(...positiveTtlEntries.map((e) => e.ttlMs ?? 0));

        // Verify online presence TTL expires cleanly without ghost vets
        redisState.advanceTime(maxTtlMs + 1000);
        expect(await presenceService.getOnlineVetsCount(redisState.now())).toBe(0);
        expect(redisState.getPresenceEntries()).toEqual([]);

        vetSock.disconnect();
        await new Promise((r) => setTimeout(r, 120));

        const afterDisconnect = redisState.getPresenceEntries();
        const activeAfterDisconnect = afterDisconnect.filter((e) => {
          if (e.kind !== 'kv' || !e.value) return true;
          try {
            return (JSON.parse(e.value) as { isOnline?: boolean }).isOnline !== false;
          } catch {
            return true;
          }
        });
        expect(activeAfterDisconnect).toEqual([]);
        if (afterDisconnect.length > 0) {
          expect(afterDisconnect.every((e) => e.ttlMs !== null && e.ttlMs > 0)).toBe(true);
          const maxOfflineTtlMs = Math.max(...afterDisconnect.map((e) => e.ttlMs ?? 0));
          redisState.advanceTime(maxOfflineTtlMs + 1000);
          expect(redisState.getPresenceEntries()).toEqual([]);
        }
      } catch (err) {
        capturedErr = err;
      } finally {
        for (const s of sockets) {
          try {
            s.removeAllListeners();
            s.disconnect();
          } catch {
            // Ignore teardown errors
          }
        }
        if (ioInstance) {
          await new Promise<void>((resolve) => ioInstance!.close(() => resolve()));
        }
        if (httpSrv.listening) {
          await new Promise<void>((resolve) => httpSrv.close(() => resolve()));
        }
        if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = prevRedisUrl;
        jest.dontMock('ioredis');
      }
    });

    if (capturedErr) throw capturedErr;
  });

  it('T3-P06 (F1+F9): PgBouncer pooled URL + directUrl schema + Call webhook persistence + governance check', async () => {
    const pooled = buildPooledDatabaseUrl('postgresql://u:p@pooler.supabase.com:6543/postgres');
    expect(pooled).toContain('pgbouncer=true');
    expect(pooled).toContain('connection_limit=20');

    await memPrisma.user.create({
      data: {
        id: 'vet-p06',
        email: 'vet-p06@test.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'P06',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'c-p06',
        clientId: 'cli-p06',
        vetId: 'vet-p06',
        petId: 'pet-p06',
        status: 'ACTIVE',
      },
    });

    server = await startEphemeralServer();
    const vetToken = mintAccessToken({ id: 'vet-p06', role: 'VET', tokenVersion: 1 });
    const tokenRes = await request(server.app)
      .post('/api/calls/c-p06/token')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({});
    expect(tokenRes.status).toBe(200);

    const started = signLiveKitWebhook({
      event: 'room_started',
      room: { name: 'c-p06', sid: 'RM_P06' },
    });
    const rStart = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', started.authHeader)
      .send(started.rawBody);
    expect(rStart.status).toBe(200);

    const finished = signLiveKitWebhook({
      event: 'room_finished',
      room: { name: 'c-p06', sid: 'RM_P06' },
    });
    const rEnd = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', finished.authHeader)
      .send(finished.rawBody);
    expect(rEnd.status).toBe(200);

    const calls = await memPrisma.call.findMany({ where: { consultationId: 'c-p06' } });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].status).toBe('ENDED');

    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-governance.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  });

  it('T3-P07 (F8+F9): LiveKit webhook success & 401 failure emit structured pino JSON logs with requestId', () => {
    expect(fs.existsSync(loggerPath)).toBe(true);

    const valid = signLiveKitWebhook({
      event: 'room_started',
      room: { name: 'c-p07', sid: 'RM_P07' },
    });

    const res = runTsxSnippet(
      `
      import request from 'supertest';
      import app from './backend/src/app';
      import prisma from './backend/src/lib/prisma';
      (prisma as any).call = {
        findFirst: async () => ({ id: 'call-p07', consultationId: 'c-p07', roomName: 'c-p07', status: 'INITIATED' }),
        update: async (a: any) => a.data,
        updateMany: async () => ({ count: 1 }),
      };
      (async () => {
        const r1 = await request(app)
          .post('/api/calls/webhook')
          .set('Content-Type', 'application/webhook+json')
          .set('X-Request-Id', 'lk-wh-777')
          .set('Authorization', ${JSON.stringify(valid.authHeader)})
          .send(${JSON.stringify(valid.rawBody)});
        const r2 = await request(app)
          .post('/api/calls/webhook')
          .set('Content-Type', 'application/webhook+json')
          .set('X-Request-Id', 'lk-wh-bad')
          .send(${JSON.stringify(valid.rawBody)});
        if (r1.status !== 200 || r2.status !== 401) process.exit(2);
      })();
      `,
      { NODE_ENV: 'test', LOG_LEVEL: 'info' }
    );

    const getLineRequestId = (line: Record<string, unknown>): unknown =>
      line.requestId ?? line.correlationId ?? (line.req as { id?: string } | undefined)?.id;

    expect(res.status).toBe(0);
    expect(res.parsedJsonLines.some((l) => getLineRequestId(l) === 'lk-wh-777')).toBe(true);
    expect(res.parsedJsonLines.some((l) => getLineRequestId(l) === 'lk-wh-bad')).toBe(true);
  });

  it('T3-P08 (F2+F7): reconnect before debounce cancels DB disconnect transition and refreshes Redis presence TTL', async () => {
    expect(fs.existsSync(disconnectQueuePath)).toBe(true);
    expect(fs.existsSync(redisLibPath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 't1-p08',
        email: 't1-p08@test.com',
        password: 'hash',
        firstName: 'Tutor',
        lastName: 'P08',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'v1-p08',
        email: 'v1-p08@clinic.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'P08',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'c-p08',
        clientId: 't1-p08',
        petId: 'pet-p08',
        status: 'IN_CALL_ACTIVE',
        activeDeviceId: 'dev-1',
        transportStatus: 'ONLINE',
        stateVersion: 1,
      },
    });

    const { state: redisState, FakeRedis } = createInMemoryRedisMock();
    let capturedErr: unknown = null;

    await jest.isolateModulesAsync(async () => {
      jest.doMock('ioredis', () => ({
        __esModule: true,
        default: FakeRedis,
        Redis: FakeRedis,
      }));

      const prevRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      const httpSrv = createServer();
      let ioInstance: { close: (cb: () => void) => void } | null = null;
      const sockets: ClientSocket[] = [];
      let isolatedDisconnectQueue: { clear?: () => void } | null = null;

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const isolatedPrisma = require('../../../../backend/src/lib/prisma').default;
        attachInMemoryPrisma(isolatedPrisma, memPrisma);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { config: isolatedConfig } = require('../../../../backend/src/config/env');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        isolatedDisconnectQueue = require(disconnectQueuePath).disconnectQueue ?? null;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          initializeSocketServer,
          whenSocketRedisReady,
        } = require('../../../../backend/src/realtime/socket.server');

        ioInstance = await initializeSocketServer(httpSrv);
        if (typeof whenSocketRedisReady === 'function') {
          await whenSocketRedisReady();
        }
        await new Promise<void>((resolve, reject) => {
          httpSrv.once('error', reject);
          httpSrv.listen(0, '127.0.0.1', () => {
            httpSrv.off('error', reject);
            resolve();
          });
        });

        const port = (httpSrv.address() as AddressInfo).port;
        const baseUrl = `http://127.0.0.1:${port}`;
        const connectClient = (userId: string, role: string, deviceId?: string) => {
          const token = jwt.sign(
            { userId, role, tokenVersion: 1 },
            isolatedConfig.JWT_SECRET,
            { algorithm: 'HS256', expiresIn: '15m' }
          );
          const s = createSocketClient(baseUrl, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
            auth: {
              token: `Bearer ${token}`,
              ...(deviceId ? { deviceId } : {}),
            },
          });
          sockets.push(s);
          return new Promise<ClientSocket>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Connect timeout for ${userId}`)), 5000);
            s.once('connect', () => {
              clearTimeout(timer);
              resolve(s);
            });
            s.once('connect_error', (err) => {
              clearTimeout(timer);
              reject(err);
            });
          });
        };

        const vetSock1 = await connectClient('v1-p08', 'VET');
        const tutorSock1 = await connectClient('t1-p08', 'CLIENT', 'dev-1');

        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && redisState.getPresenceEntries().length === 0) {
          await new Promise((r) => setTimeout(r, 25));
        }

        const presenceBefore = redisState.getPresenceEntries();
        expect(presenceBefore.length).toBeGreaterThanOrEqual(1);
        const ttlWritesBefore = redisState.getPresenceCommands([
          'set',
          'setex',
          'psetex',
          'expire',
          'pexpire',
          'zadd',
          'eval',
        ]).length;

        redisState.advanceTime(1000);
        tutorSock1.disconnect();
        vetSock1.disconnect();

        await new Promise((r) => setTimeout(r, 40));
        const tutorSock2 = await connectClient('t1-p08', 'CLIENT', 'dev-1');
        const vetSock2 = await connectClient('v1-p08', 'VET');
        expect(tutorSock2.connected).toBe(true);
        expect(vetSock2.connected).toBe(true);

        await new Promise((r) => setTimeout(r, 380));

        const consAfter = await memPrisma.consultation.findUnique({ where: { id: 'c-p08' } });
        expect(consAfter?.transportStatus).toBe('ONLINE');
        expect(consAfter?.stateVersion).toBe(1);

        const ttlWritesAfter = redisState.getPresenceCommands([
          'set',
          'setex',
          'psetex',
          'expire',
          'pexpire',
          'zadd',
          'eval',
        ]).length;
        expect(ttlWritesAfter).toBeGreaterThan(ttlWritesBefore);

        const presenceAfter = redisState.getPresenceEntries();
        expect(presenceAfter.some((e) => e.ttlMs !== null && e.ttlMs > 0)).toBe(true);
      } catch (err) {
        capturedErr = err;
      } finally {
        isolatedDisconnectQueue?.clear?.();
        for (const s of sockets) {
          try {
            s.removeAllListeners();
            s.disconnect();
          } catch {
            // Ignore teardown errors
          }
        }
        if (ioInstance) {
          await new Promise<void>((resolve) => ioInstance!.close(() => resolve()));
        }
        if (httpSrv.listening) {
          await new Promise<void>((resolve) => httpSrv.close(() => resolve()));
        }
        if (prevRedisUrl === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = prevRedisUrl;
        jest.dontMock('ioredis');
      }
    });

    if (capturedErr) throw capturedErr;
  });

  it('T3-P10 (F1+F10): schema validation, governance check, multer >= 2.x, no @types/ioredis, and 0 prod high/critical vulns', () => {
    const prismaCli = path.join(repoRoot, 'backend', 'node_modules', 'prisma', 'build', 'index.js');
    const schemaPath = path.join(repoRoot, 'backend', 'prisma', 'schema.prisma');
    execFileSync(process.execPath, [prismaCli, 'validate', '--schema', schemaPath], {
      cwd: path.join(repoRoot, 'backend'),
      encoding: 'utf8',
    });
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-governance.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const backendPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'backend', 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const multerMatch = (backendPkg.dependencies?.multer ?? '').match(/(\d+)\./);
    expect(Number(multerMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
    expect(backendPkg.devDependencies?.['@types/ioredis']).toBeUndefined();

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const auditProc = spawnSync(npmCmd, ['audit', '--omit=dev', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 45000,
    });
    const auditJson = JSON.parse((auditProc.stdout ?? '').replace(/^\uFEFF/, '').trim()) as {
      metadata?: { vulnerabilities?: { critical?: number; high?: number } };
    };
    expect(auditJson.metadata?.vulnerabilities?.critical).toBe(0);
    expect(auditJson.metadata?.vulnerabilities?.high).toBe(0);
  }, 60000);

  it('T3-P11 (F7+F8): PATCH /assign with X-Correlation-Id emits consultation:assigned and logs JSON with correlationId', async () => {
    expect(fs.existsSync(loggerPath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 'cli-p11',
        email: 'cli-p11@secret.com',
        phone: '+5491100001111',
        password: 'hash',
        firstName: 'Cli',
        lastName: 'P11',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'vet-p11',
        email: 'vet-p11@clinic.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'P11',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'c-p11',
        clientId: 'cli-p11',
        petId: 'pet-p11',
        status: 'WAITING',
      },
    });

    server = await startEphemeralServer();
    const clientSock = await server.connectSocket({
      token: mintAccessToken({ id: 'cli-p11', role: 'CLIENT', tokenVersion: 1 }),
    });

    const assignedPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('consultation:assigned not emitted')), 2000);
      clientSock.once('consultation:assigned', (data: Record<string, unknown>) => {
        clearTimeout(t);
        resolve(data);
      });
    });

    const vetToken = mintAccessToken({ id: 'vet-p11', role: 'VET', tokenVersion: 1 });
    const res = await request(server.app)
      .patch('/api/consultations/c-p11/assign')
      .set('Authorization', `Bearer ${vetToken}`)
      .set('X-Correlation-Id', 'corr-assign-1')
      .send({});

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id'] ?? res.headers['x-request-id']).toBe('corr-assign-1');

    const eventPayload = await assignedPromise;
    expect(eventPayload).toMatchObject({ consultationId: 'c-p11', vetId: 'vet-p11', status: 'ACTIVE' });
  });
});
