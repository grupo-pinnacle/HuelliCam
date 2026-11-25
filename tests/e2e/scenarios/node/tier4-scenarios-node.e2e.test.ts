import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import request from 'supertest';
import prisma from '../../../../backend/src/lib/prisma';
import { setConcurrencySchemaSupportForTest } from '../../../../backend/src/modules/consultations/consultationConcurrency.service';
import { attachInMemoryPrisma, InMemoryPrisma } from '../../helpers/node/inMemoryPrisma';
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

describe('Tier 4 — Real-World Veterinary Telemedicine E2E Scenarios (Node/Backend)', () => {
  let memPrisma: InMemoryPrisma;
  let server: EphemeralServerHandle | null = null;
  let secondServer: EphemeralServerHandle | null = null;

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
    if (secondServer) {
      await secondServer.close();
      secondServer = null;
    }
  });

  it('T4-S02: mass 50-tutor mobile signal drop & 35 partial reconnect storm under PgBouncer CAS & debounced queue', async () => {
    expect(fs.existsSync(disconnectQueuePath)).toBe(true);

    const total = 50;
    const reconnectCount = 35;

    for (let i = 0; i < total; i++) {
      await memPrisma.user.create({
        data: {
          id: `storm-tutor-${i}`,
          email: `storm-${i}@test.com`,
          password: 'hash',
          firstName: `Tutor${i}`,
          lastName: 'Storm',
          role: 'CLIENT',
          tokenVersion: 1,
        },
      });
      await memPrisma.consultation.create({
        data: {
          id: `storm-cons-${i}`,
          clientId: `storm-tutor-${i}`,
          petId: `storm-pet-${i}`,
          status: 'IN_CALL_ACTIVE',
          activeDeviceId: `storm-dev-${i}`,
          transportStatus: 'ONLINE',
          stateVersion: 1,
        },
      });
    }

    server = await startEphemeralServer();

    const sockets = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        server!.connectSocket({
          token: mintAccessToken({ id: `storm-tutor-${i}`, role: 'CLIENT', tokenVersion: 1 }),
          deviceId: `storm-dev-${i}`,
        })
      )
    );

    // Simulate mass cell-tower drop
    for (const sock of sockets) {
      sock.disconnect();
    }

    // At t = 30ms (< debounce 150ms), 0 DB GRACE_DISCONNECTED writes or FOR UPDATE locks
    await new Promise((r) => setTimeout(r, 30));
    const immediateDisconnected = memPrisma.store.consultation.filter(
      (c) => c.transportStatus === 'GRACE_DISCONNECTED'
    );
    expect(immediateDisconnected).toHaveLength(0);
    expect(memPrisma.capturedSql.filter((q) => /\bFOR\s+UPDATE\b/i.test(q.sql))).toEqual([]);

    // 35 tutors reconnect within debounce window
    await Promise.all(
      Array.from({ length: reconnectCount }, (_, i) =>
        server!.connectSocket({
          token: mintAccessToken({ id: `storm-tutor-${i}`, role: 'CLIENT', tokenVersion: 1 }),
          deviceId: `storm-dev-${i}`,
        })
      )
    );

    // Wait past 300ms debounce window for remaining 15 offline tutors
    await new Promise((r) => setTimeout(r, 450));

    const reconnectedRows = memPrisma.store.consultation.filter((c) => {
      const idx = Number(String(c.id).replace('storm-cons-', ''));
      return idx < reconnectCount;
    });
    const offlineRows = memPrisma.store.consultation.filter((c) => {
      const idx = Number(String(c.id).replace('storm-cons-', ''));
      return idx >= reconnectCount;
    });

    expect(reconnectedRows.every((r) => r.transportStatus === 'ONLINE')).toBe(true);
    expect(offlineRows.every((r) => r.transportStatus === 'GRACE_DISCONNECTED')).toBe(true);
    expect(offlineRows.every((r) => r.stateVersion === 2)).toBe(true);

    const disconnectAudits = memPrisma.store.consultationAuditLog.filter(
      (a) => a.eventType === 'SOCKET_DISCONNECT'
    );
    expect(disconnectAudits).toHaveLength(total - reconnectCount);
    expect(memPrisma.capturedSql.filter((q) => /\bFOR\s+UPDATE\b/i.test(q.sql))).toEqual([]);
  }, 30000);

  it('T4-S04: multi-pod presence preservation + production fail-fast without InMemoryAdapter fallback', async () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);
    expect(fs.existsSync(loggerPath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 'vet-pod-a',
        email: 'vet-poda@test.com',
        password: 'hash',
        firstName: 'PodA',
        lastName: 'Vet',
        role: 'VET',
        vetStatus: 'APPROVED',
        isOnline: false,
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'cli-pod-b',
        email: 'cli-podb@test.com',
        password: 'hash',
        firstName: 'PodB',
        lastName: 'Cli',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.pet.create({
      data: {
        id: 'pet-podb',
        ownerId: 'cli-pod-b',
        name: 'Luna',
        species: 'Gato',
        breed: 'Siames',
      },
    });

    // Pod A starts and connects Vet
    server = await startEphemeralServer();
    await server.connectSocket({
      token: mintAccessToken({ id: 'vet-pod-a', role: 'VET', tokenVersion: 1 }),
    });

    memPrisma.methodCalls = [];
    // Pod B starts while Vet is active on Pod A
    secondServer = await startEphemeralServer();
    const updateManyWipes = memPrisma.methodCalls.filter(
      (c) => c.model === 'user' && c.method === 'updateMany'
    );
    expect(updateManyWipes).toHaveLength(0);

    // Pod C in production with unreachable Redis MUST fail fast and log JSON error
    const podC = runTsxSnippet(
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
        LOG_LEVEL: 'error',
      }
    );

    expect(podC.error).toBeUndefined();
    expect(podC.stdout).not.toContain('UNEXPECTED_FALLBACK');
    expect(podC.stderr).not.toMatch(
      /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|Validación de variables de entorno fallida/i
    );
    expect(podC.stderr).toContain('FAILED_FAST:');
    expect(podC.status).toBe(1);
  });

  it('T4-S05: end-to-end correlated tracing, webhook abort telemetry, governance, and prod audit compliance', async () => {
    expect(fs.existsSync(loggerPath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 'cli-s05',
        email: 'cli-s05@test.com',
        password: 'hash',
        firstName: 'Cli',
        lastName: 'S05',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'vet-s05',
        email: 'vet-s05@test.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'S05',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'c-s05',
        clientId: 'cli-s05',
        vetId: 'vet-s05',
        petId: 'pet-s05',
        status: 'ACTIVE',
      },
    });

    server = await startEphemeralServer();
    const cliToken = mintAccessToken({ id: 'cli-s05', role: 'CLIENT', tokenVersion: 1 });
    const vetToken = mintAccessToken({ id: 'vet-s05', role: 'VET', tokenVersion: 1 });

    // 1. Validation error carries matching requestId
    const badRes = await request(server.app)
      .post('/api/consultations')
      .set('Authorization', `Bearer ${cliToken}`)
      .set('X-Correlation-Id', 'trace-e2e-900')
      .set('X-Forwarded-For', '10.4.5.1')
      .send({ petId: '', notes: '' });
    expect(badRes.status).toBe(400);
    expect(badRes.body?.error?.code).toBe('VALIDATION_ERROR');
    expect(badRes.body?.error?.requestId).toBe('trace-e2e-900');

    // 2. Call token creates Call row
    const tokRes = await request(server.app)
      .post('/api/calls/c-s05/token')
      .set('Authorization', `Bearer ${vetToken}`)
      .set('X-Correlation-Id', 'trace-e2e-900')
      .send({});
    expect(tokRes.status).toBe(200);

    // 3. Pretty application/json participant_connection_aborted webhook updates Call telemetry
    const abortSigned = signLiveKitWebhook(
      {
        event: 'participant_connection_aborted',
        room: { name: 'c-s05', sid: 'RM_S05' },
        participant: { identity: 'cli-s05', sid: 'PA_S05' },
      },
      { pretty: true }
    );
    const whOk = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'trace-lk-err-900')
      .set('Authorization', abortSigned.authHeader)
      .send(abortSigned.rawBody);
    expect(whOk.status).toBe(200);

    const callRows = await memPrisma.call.findMany({ where: { consultationId: 'c-s05' } });
    expect(callRows.length).toBeGreaterThanOrEqual(1);
    const { id: _id, roomName: _room, consultationId: _cid, ...telemetryFields } = callRows[0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(telemetryFields)).toMatch(/abort|error|fail|disconnect/i);

    // 4. Unauthorized webhook rejected with 401
    const whBad = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', `${abortSigned.authHeader}bad`)
      .send(abortSigned.rawBody);
    expect([401, 403]).toContain(whBad.status);

    // 5. Governance, Prisma schema validate, multer@2.x, no @types/ioredis, and 0 prod high/critical audit
    execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-governance.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const prismaCli = path.join(repoRoot, 'backend', 'node_modules', 'prisma', 'build', 'index.js');
    execFileSync(
      process.execPath,
      [prismaCli, 'validate', '--schema', path.join(repoRoot, 'backend', 'prisma', 'schema.prisma')],
      { cwd: path.join(repoRoot, 'backend'), encoding: 'utf8' }
    );

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
});
