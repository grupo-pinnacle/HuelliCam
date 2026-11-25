import fs from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import jwt from 'jsonwebtoken';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import prisma from '../../../backend/src/lib/prisma';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';
import { createInMemoryRedisMock } from '../helpers/node/inMemoryRedis';
import {
  EphemeralServerHandle,
  mintAccessToken,
  startEphemeralServer,
} from '../helpers/node/ephemeralServer';

const repoRoot = path.resolve(__dirname, '../../..');
const redisLibPath = path.join(repoRoot, 'backend', 'src', 'lib', 'redis.ts');

describe('F07 — Redis-Backed Presence with TTL & Reactive Backend Events (M3)', () => {
  let memPrisma: InMemoryPrisma;
  let server: EphemeralServerHandle | null = null;

  beforeAll(() => {
    memPrisma = new InMemoryPrisma();
    attachInMemoryPrisma(prisma, memPrisma);
  });

  beforeEach(() => {
    memPrisma.reset();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  async function seedUsersAndPet() {
    await memPrisma.user.create({
      data: {
        id: 'cli-1',
        email: 'tutor@secret.com',
        phone: '+5491199999999',
        password: 'hash',
        firstName: 'Ana',
        lastName: 'Tutor',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'vet-1',
        email: 'vet1@clinic.com',
        password: 'hash',
        firstName: 'Carlos',
        lastName: 'Vet',
        role: 'VET',
        vetStatus: 'APPROVED',
        isOnline: false,
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'vet-2',
        email: 'vet2@clinic.com',
        password: 'hash',
        firstName: 'Lucia',
        lastName: 'Vet',
        role: 'VET',
        vetStatus: 'APPROVED',
        isOnline: false,
        tokenVersion: 1,
      },
    });
    await memPrisma.pet.create({
      data: {
        id: 'pet-1',
        ownerId: 'cli-1',
        name: 'Firulais',
        species: 'Perro',
        breed: 'Mestizo',
      },
    });
  }

  it('T1-F07-01: approved VET connect sets Redis presence with positive TTL and emits vet:presence', async () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);
    await seedUsersAndPet();

    server = await startEphemeralServer();
    const vet2Sock = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-2', role: 'VET', tokenVersion: 1 }),
    });

    const presencePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('vet:presence event not received')), 2000);
      vet2Sock.on('vet:presence', (payload: Record<string, unknown>) => {
        if (payload?.vetId === 'vet-1') {
          clearTimeout(timer);
          resolve(payload);
        }
      });
    });

    await server.connectSocket({
      token: mintAccessToken({ id: 'vet-1', role: 'VET', tokenVersion: 1 }),
    });

    const presencePayload = await presencePromise;
    expect(presencePayload).toMatchObject({ vetId: 'vet-1', isOnline: true });
  });

  it('T1-F07-02: pod startup does NOT execute global prisma.user.updateMany({ isOnline: false }) wipe', async () => {
    await seedUsersAndPet();
    await memPrisma.user.update({ where: { id: 'vet-1' }, data: { isOnline: true } });
    memPrisma.methodCalls = [];

    server = await startEphemeralServer();
    await new Promise((r) => setTimeout(r, 50));

    const wipeCalls = memPrisma.methodCalls.filter(
      (c) => c.model === 'user' && c.method === 'updateMany'
    );
    expect(wipeCalls).toHaveLength(0);

    const vetAfter = await memPrisma.user.findUnique({ where: { id: 'vet-1' } });
    expect(vetAfter?.isOnline).toBe(true);
  });

  it('T1-F07-03: PATCH /api/consultations/:id/assign emits consultation:assigned to client and role:vets', async () => {
    await seedUsersAndPet();
    await memPrisma.consultation.create({
      data: {
        id: 'cons-assign',
        clientId: 'cli-1',
        petId: 'pet-1',
        status: 'WAITING',
        notes: 'Fiebre',
      },
    });

    server = await startEphemeralServer();
    const clientSock = await server.connectSocket({
      token: mintAccessToken({ id: 'cli-1', role: 'CLIENT', tokenVersion: 1 }),
    });
    const vet2Sock = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-2', role: 'VET', tokenVersion: 1 }),
    });

    const clientEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('consultation:assigned not received by client')),
        2000
      );
      clientSock.once('consultation:assigned', (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    const vet2Event = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('consultation:assigned not received by role:vets')),
        2000
      );
      vet2Sock.once('consultation:assigned', (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    const vet1Token = mintAccessToken({ id: 'vet-1', role: 'VET', tokenVersion: 1 });
    const res = await request(server.app)
      .patch('/api/consultations/cons-assign/assign')
      .set('Authorization', `Bearer ${vet1Token}`)
      .send({});

    expect(res.status).toBe(200);

    const [cPayload, vPayload] = await Promise.all([clientEvent, vet2Event]);
    expect(cPayload).toMatchObject({
      consultationId: 'cons-assign',
      vetId: 'vet-1',
      clientId: 'cli-1',
      status: 'ACTIVE',
    });
    expect(vPayload).toMatchObject({
      consultationId: 'cons-assign',
      vetId: 'vet-1',
      status: 'ACTIVE',
    });
    expect((vPayload as { email?: string }).email).toBeUndefined();
    expect((vPayload as { phone?: string }).phone).toBeUndefined();
  });

  it('T1-F07-04: PATCH /api/consultations/:id/cancel emits consultation:cancelled to consultation room and role:vets', async () => {
    await seedUsersAndPet();
    await memPrisma.consultation.create({
      data: {
        id: 'cons-cancel',
        clientId: 'cli-1',
        petId: 'pet-1',
        status: 'WAITING',
        notes: 'Cancelacion test',
      },
    });

    server = await startEphemeralServer();
    const vetSock = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-2', role: 'VET', tokenVersion: 1 }),
    });

    const cancelledEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('consultation:cancelled not received')), 2000);
      vetSock.once('consultation:cancelled', (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    const clientToken = mintAccessToken({ id: 'cli-1', role: 'CLIENT', tokenVersion: 1 });
    const res = await request(server.app)
      .patch('/api/consultations/cons-cancel/cancel')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ reason: 'Improved' });

    expect(res.status).toBe(200);

    const payload = await cancelledEvent;
    expect(payload).toMatchObject({
      consultationId: 'cons-cancel',
      cancelledBy: 'cli-1',
      status: 'CANCELLED',
    });
  });

  it('T1-F07-05: POST /api/consultations/:id/prescriptions emits prescription:new to client and consultation room', async () => {
    await seedUsersAndPet();
    await memPrisma.consultation.create({
      data: {
        id: 'cons-rx',
        clientId: 'cli-1',
        vetId: 'vet-1',
        petId: 'pet-1',
        status: 'ACTIVE',
      },
    });

    server = await startEphemeralServer();
    const clientSock = await server.connectSocket({
      token: mintAccessToken({ id: 'cli-1', role: 'CLIENT', tokenVersion: 1 }),
    });
    clientSock.emit('join:consultation', { consultationId: 'cons-rx' });
    await new Promise((r) => setTimeout(r, 50));

    const rxEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('prescription:new not received')), 2000);
      clientSock.once('prescription:new', (data: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    const vetToken = mintAccessToken({ id: 'vet-1', role: 'VET', tokenVersion: 1 });
    const res = await request(server.app)
      .post('/api/consultations/cons-rx/prescriptions')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({
        medication: 'Amoxicilina',
        dosage: '250mg',
        frequency: 'Cada 12h',
        durationDays: 7,
        indications: 'Administrar con alimento despues de comer.',
      });

    expect(res.status).toBe(201);

    const payload = await rxEvent;
    expect(payload).toMatchObject({
      consultationId: 'cons-rx',
      petId: 'pet-1',
    });
    expect(typeof payload.prescriptionId).toBe('string');
  });

  it('T2-F07-01: PENDING/REJECTED vet never joins role:vets and never receives consultation:new', async () => {
    await seedUsersAndPet();
    await memPrisma.user.create({
      data: {
        id: 'vet-pending',
        email: 'pending@clinic.com',
        password: 'hash',
        firstName: 'Pending',
        lastName: 'Vet',
        role: 'VET',
        vetStatus: 'PENDING',
        tokenVersion: 1,
      },
    });

    server = await startEphemeralServer();
    const pendingSock = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-pending', role: 'VET', tokenVersion: 1 }),
    });

    let leaked = false;
    pendingSock.on('consultation:new', () => {
      leaked = true;
    });

    const clientToken = mintAccessToken({ id: 'cli-1', role: 'CLIENT', tokenVersion: 1 });
    const res = await request(server.app)
      .post('/api/consultations')
      .set('Authorization', `Bearer ${clientToken}`)
      .set('X-Forwarded-For', '10.7.0.1')
      .send({ petId: 'pet-1', notes: 'Vomitos frecuentes' });

    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 120));
    expect(leaked).toBe(false);
  });

  it('T2-F07-02: multi-tab vet presence keeps vet online until final socket disconnects', async () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);
    await seedUsersAndPet();

    server = await startEphemeralServer();
    const observerVet = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-2', role: 'VET', tokenVersion: 1 }),
    });

    const presenceEvents: Array<{ vetId: string; isOnline: boolean }> = [];
    observerVet.on('vet:presence', (ev: { vetId: string; isOnline: boolean }) => {
      if (ev.vetId === 'vet-1') {
        presenceEvents.push(ev);
      }
    });

    const tab1 = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-1', role: 'VET', tokenVersion: 1 }),
    });
    const tab2 = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-1', role: 'VET', tokenVersion: 1 }),
    });

    await new Promise((r) => setTimeout(r, 80));
    tab1.disconnect();
    await new Promise((r) => setTimeout(r, 120));

    expect(presenceEvents.some((e) => e.isOnline === false)).toBe(false);

    tab2.disconnect();
    await new Promise((r) => setTimeout(r, 120));

    expect(presenceEvents.some((e) => e.isOnline === false)).toBe(true);
  });

  it('T2-F07-03: Redis presence persists presence:* key with positive TTL and expires/cleans up cleanly on disconnect/TTL expiry', async () => {
    expect(fs.existsSync(redisLibPath)).toBe(true);
    await seedUsersAndPet();

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
        const isolatedPrisma = require('../../../backend/src/lib/prisma').default;
        attachInMemoryPrisma(isolatedPrisma, memPrisma);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { config: isolatedConfig } = require('../../../backend/src/config/env');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          initializeSocketServer,
          whenSocketRedisReady,
        } = require('../../../backend/src/realtime/socket.server');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { presenceService } = require('../../../backend/src/realtime/presence.service');

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
          { userId: 'vet-1', role: 'VET', tokenVersion: 1 },
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

        // Poll briefly for async Redis presence persistence
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && redisState.getPresenceEntries().length === 0) {
          await new Promise((r) => setTimeout(r, 25));
        }

        const activeEntries = redisState.getPresenceEntries();
        expect(activeEntries.length).toBeGreaterThanOrEqual(1);
        const withTtl = activeEntries.filter((e) => e.ttlMs !== null && e.ttlMs > 0);
        expect(withTtl.length).toBeGreaterThanOrEqual(1);

        const maxTtlMs = Math.max(...withTtl.map((e) => e.ttlMs ?? 0));
        expect(maxTtlMs).toBeGreaterThan(0);

        // Verify TTL expiry of active online presence keys without disconnect (no ghost vets)
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
          // Offline lastSeen record retained with finite positive TTL expires cleanly too
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

  it('T2-F07-04: approved vet connect does not execute duplicate prisma.user.update isOnline writes', async () => {
    await seedUsersAndPet();
    memPrisma.methodCalls = [];

    server = await startEphemeralServer();
    await server.connectSocket({
      token: mintAccessToken({ id: 'vet-1', role: 'VET', tokenVersion: 1 }),
    });
    await new Promise((r) => setTimeout(r, 80));

    const userUpdateCalls = memPrisma.methodCalls.filter(
      (c) => c.model === 'user' && c.method === 'update'
    );
    expect(userUpdateCalls.length).toBeLessThanOrEqual(1);
  });

  it('T2-F07-05: consultation:new broadcast redacts client email and phone PII', async () => {
    await seedUsersAndPet();

    server = await startEphemeralServer();
    const vetSock = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-2', role: 'VET', tokenVersion: 1 }),
    });

    const received = new Promise<{ client?: { email?: string; phone?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('consultation:new not received')), 2000);
      vetSock.once('consultation:new', (payload: { client?: { email?: string; phone?: string } }) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    const clientToken = mintAccessToken({ id: 'cli-1', role: 'CLIENT', tokenVersion: 1 });
    const res = await request(server.app)
      .post('/api/consultations')
      .set('Authorization', `Bearer ${clientToken}`)
      .set('X-Forwarded-For', '10.7.0.2')
      .send({ petId: 'pet-1', notes: 'Control general' });

    expect(res.status).toBe(201);
    const eventPayload = await received;
    expect(eventPayload.client).toBeDefined();
    expect(eventPayload.client?.email).toBeUndefined();
    expect(eventPayload.client?.phone).toBeUndefined();
  });
});
