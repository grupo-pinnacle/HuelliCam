import fs from 'fs';
import path from 'path';
import prisma from '../../../backend/src/lib/prisma';
import {
  consultationConcurrencyService,
  setConcurrencySchemaSupportForTest,
} from '../../../backend/src/modules/consultations/consultationConcurrency.service';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';
import {
  EphemeralServerHandle,
  mintAccessToken,
  startEphemeralServer,
} from '../helpers/node/ephemeralServer';

const repoRoot = path.resolve(__dirname, '../../..');
const disconnectQueuePath = path.join(repoRoot, 'backend', 'src', 'realtime', 'disconnectQueue.ts');

interface DisconnectQueueApi {
  enqueue: (tutorId: string, deviceId: string) => void;
  cancel: (tutorId: string, deviceId: string) => boolean;
  flushAll: () => Promise<void>;
  clear: () => void;
  pendingCount?: number;
}

type DisconnectQueueCtor = new (opts?: { debounceMs?: number }) => DisconnectQueueApi;

function loadDisconnectQueueModule(customDebounceMs?: number): DisconnectQueueApi {
  expect(fs.existsSync(disconnectQueuePath)).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(disconnectQueuePath) as Record<string, unknown>;
  if (customDebounceMs !== undefined && typeof mod.DisconnectQueue === 'function') {
    const Ctor = mod.DisconnectQueue as DisconnectQueueCtor;
    return new Ctor({ debounceMs: customDebounceMs });
  }
  const target = (mod.disconnectQueue ?? mod.default ?? mod) as Partial<DisconnectQueueApi>;
  expect(typeof target.enqueue).toBe('function');
  expect(typeof target.cancel).toBe('function');
  expect(typeof target.clear).toBe('function');
  return target as DisconnectQueueApi;
}

describe('F02 — Debounced Disconnect Queue (markSocketDisconnect) (M1)', () => {
  let memPrisma: InMemoryPrisma;
  let server: EphemeralServerHandle | null = null;

  beforeAll(() => {
    memPrisma = new InMemoryPrisma();
    attachInMemoryPrisma(prisma, memPrisma);
  });

  beforeEach(() => {
    memPrisma.reset();
    setConcurrencySchemaSupportForTest(true);
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (fs.existsSync(disconnectQueuePath)) {
      try {
        const q = loadDisconnectQueueModule();
        q.clear();
      } catch {
        // Ignore if module cannot load during teardown
      }
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('T1-F02-01: enqueue defers markSocketDisconnect until debounce window or flushAll()', async () => {
    const queue = loadDisconnectQueueModule(200);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();
    queue.enqueue('tutor-1', 'dev-1');

    expect(spy).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(150);
    expect(spy).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(60);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('tutor-1', 'dev-1');
  });

  it('T1-F02-02: cancel() within debounce window aborts pending DB disconnect', async () => {
    const queue = loadDisconnectQueueModule(200);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();
    queue.enqueue('tutor-1', 'dev-1');

    await jest.advanceTimersByTimeAsync(50);
    const cancelled = queue.cancel('tutor-1', 'dev-1');
    expect(cancelled).toBe(true);

    await jest.advanceTimersByTimeAsync(500);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('T1-F02-03: real Socket.io CLIENT disconnect keeps transportStatus ONLINE immediately and transitions after debounce', async () => {
    expect(fs.existsSync(disconnectQueuePath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 'tutor-ws',
        email: 'tutor-ws@test.com',
        password: 'hash',
        firstName: 'Tutor',
        lastName: 'WS',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'cons-ws',
        clientId: 'tutor-ws',
        petId: 'pet-ws',
        status: 'IN_CALL_ACTIVE',
        activeDeviceId: 'dev-1',
        transportStatus: 'ONLINE',
        stateVersion: 1,
      },
    });

    server = await startEphemeralServer();
    const token = mintAccessToken({ id: 'tutor-ws', role: 'CLIENT', tokenVersion: 1 });
    const client = await server.connectSocket({ token, deviceId: 'dev-1' });

    client.disconnect();
    await new Promise((r) => setTimeout(r, 40));

    const immediateRow = await memPrisma.consultation.findUnique({ where: { id: 'cons-ws' } });
    expect(immediateRow?.transportStatus).toBe('ONLINE');

    await new Promise((r) => setTimeout(r, 380));
    const afterDebounceRow = await memPrisma.consultation.findUnique({ where: { id: 'cons-ws' } });
    expect(afterDebounceRow?.transportStatus).toBe('GRACE_DISCONNECTED');
    expect(afterDebounceRow?.stateVersion).toBe(2);

    const audits = await memPrisma.consultationAuditLog.findMany({
      where: { consultationId: 'cons-ws', eventType: 'SOCKET_DISCONNECT' },
    });
    expect(audits).toHaveLength(1);
  });

  it('T1-F02-04: coalesces 5 rapid enqueues for same (tutorId, deviceId) into at most 1 DB call', async () => {
    const queue = loadDisconnectQueueModule(150);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();
    for (let i = 0; i < 5; i++) {
      queue.enqueue('tutor-flap', 'dev-flap');
    }

    await jest.advanceTimersByTimeAsync(250);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('tutor-flap', 'dev-flap');
  });

  it('T1-F02-05: clear() and flushAll() clean up all pending timers without leaking handles', async () => {
    const queue = loadDisconnectQueueModule(5000);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();
    queue.enqueue('t1', 'd1');
    queue.enqueue('t2', 'd2');
    queue.enqueue('t3', 'd3');

    queue.clear();
    await jest.advanceTimersByTimeAsync(6000);
    expect(spy).toHaveBeenCalledTimes(0);

    queue.enqueue('t4', 'd4');
    if (typeof queue.flushAll === 'function') {
      await queue.flushAll();
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('T2-F02-01: rapid disconnect -> reconnect -> disconnect resets debounce window cleanly', async () => {
    const queue = loadDisconnectQueueModule(100);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();

    queue.enqueue('t1', 'd1');
    await jest.advanceTimersByTimeAsync(60);
    expect(queue.cancel('t1', 'd1')).toBe(true);

    await jest.advanceTimersByTimeAsync(10); // t=70ms
    queue.enqueue('t1', 'd1');

    await jest.advanceTimersByTimeAsync(50); // t=120ms (50ms since 2nd enqueue)
    expect(spy).toHaveBeenCalledTimes(0);

    await jest.advanceTimersByTimeAsync(60); // t=180ms (110ms since 2nd enqueue)
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('T2-F02-02: multi-device isolation prevents dev-new cancel from cancelling dev-old', async () => {
    const queue = loadDisconnectQueueModule(100);
    await memPrisma.consultation.create({
      data: {
        id: 'cons-multi',
        clientId: 't1',
        petId: 'pet-multi',
        status: 'IN_CALL_ACTIVE',
        activeDeviceId: 'dev-new',
        transportStatus: 'ONLINE',
        stateVersion: 2,
      },
    });

    jest.useFakeTimers();
    queue.clear();
    queue.enqueue('t1', 'dev-old');

    const cancelledOther = queue.cancel('t1', 'dev-new');
    expect(cancelledOther).toBe(false);

    await jest.advanceTimersByTimeAsync(150);
    const unchanged = await memPrisma.consultation.findUnique({ where: { id: 'cons-multi' } });
    expect(unchanged?.transportStatus).toBe('ONLINE');
    expect(unchanged?.activeDeviceId).toBe('dev-new');
  });

  it('T2-F02-03: VET disconnect or CLIENT without deviceId never triggers markSocketDisconnect', async () => {
    expect(fs.existsSync(disconnectQueuePath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 'vet-disc',
        email: 'vet-disc@test.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'Disc',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'client-nodev',
        email: 'client-nodev@test.com',
        password: 'hash',
        firstName: 'Client',
        lastName: 'NoDev',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });

    const spy = jest.spyOn(consultationConcurrencyService, 'markSocketDisconnect');

    server = await startEphemeralServer();
    const vetSock = await server.connectSocket({
      token: mintAccessToken({ id: 'vet-disc', role: 'VET', tokenVersion: 1 }),
      deviceId: 'vet-dev-1',
    });
    const clientNoDevSock = await server.connectSocket({
      token: mintAccessToken({ id: 'client-nodev', role: 'CLIENT', tokenVersion: 1 }),
    });

    vetSock.disconnect();
    clientNoDevSock.disconnect();
    await new Promise((r) => setTimeout(r, 380));

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('T2-F02-04: transient DB error during flush does not crash queue for subsequent disconnects', async () => {
    const queue = loadDisconnectQueueModule(80);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockRejectedValueOnce(new Error('Transient DB connection reset'))
      .mockResolvedValueOnce({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();
    queue.enqueue('t1', 'd1');
    await jest.advanceTimersByTimeAsync(100);

    queue.enqueue('t2', 'd2');
    await jest.advanceTimersByTimeAsync(100);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(2, 't2', 'd2');
  });

  it('T2-F02-05: 200 concurrent disconnect storm processes cleanly without hanging or leaking timers', async () => {
    const queue = loadDisconnectQueueModule(120);
    const spy = jest
      .spyOn(consultationConcurrencyService, 'markSocketDisconnect')
      .mockResolvedValue({ updated: true, rowCount: 1 });

    jest.useFakeTimers();
    queue.clear();
    for (let i = 0; i < 200; i++) {
      queue.enqueue(`tutor-${i}`, `dev-${i}`);
    }

    await jest.advanceTimersByTimeAsync(200);
    expect(spy).toHaveBeenCalledTimes(200);
    queue.clear();
  });
});
