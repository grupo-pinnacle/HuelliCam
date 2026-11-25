import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { Role, VetStatus } from '@prisma/client';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    consultation: {
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((cb: any) => cb(require('../lib/prisma').default)),
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
}));

import prisma from '../lib/prisma';
import { setSharedRedisClient } from '../lib/redis';
import {
  PRESENCE_TTL_MS,
  PresenceService,
  VETS_ONLINE_KEY,
  presenceService,
} from '../realtime/presence.service';
import { initializeSocketServer, whenSocketRedisReady } from '../realtime/socket.server';
import { UsersService } from '../modules/users/users.service';
import { AdminService } from '../modules/admin/admin.service';

/**
 * Lightweight in-process Redis ZSET + KV simulator implementing the exact
 * ioredis commands used by PresenceService so unit tests exercise the real
 * Redis command path (pipelines, ZREMRANGEBYSCORE, ZADD, ZCARD, MGET, DEL).
 */
class InMemoryRedisMock {
  public status = 'ready';
  private kv = new Map<string, { value: string; expiresAt: number | null }>();
  private zsets = new Map<string, Map<string, number>>();
  private zsetExpires = new Map<string, number>();

  public async quit(): Promise<'OK'> {
    this.status = 'end';
    return 'OK';
  }

  public disconnect(_reconnect?: boolean): void {
    this.status = 'end';
  }

  public clock = () => Date.now();

  private sweepExpired() {
    const now = this.clock();
    for (const [k, entry] of this.kv.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.kv.delete(k);
      }
    }
    for (const [k, exp] of this.zsetExpires.entries()) {
      if (exp <= now) {
        this.zsets.delete(k);
        this.zsetExpires.delete(k);
      }
    }
  }

  public async get(key: string): Promise<string | null> {
    this.sweepExpired();
    return this.kv.get(key)?.value ?? null;
  }

  public async set(
    key: string,
    value: string,
    mode?: 'PX' | 'EX',
    ttl?: number
  ): Promise<'OK'> {
    const now = this.clock();
    let expiresAt: number | null = null;
    if (mode === 'PX' && typeof ttl === 'number') {
      expiresAt = now + ttl;
    } else if (mode === 'EX' && typeof ttl === 'number') {
      expiresAt = now + ttl * 1000;
    }
    this.kv.set(key, { value, expiresAt });
    return 'OK';
  }

  public async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) deleted++;
      if (this.zsets.delete(k)) deleted++;
      this.zsetExpires.delete(k);
    }
    return deleted;
  }

  public async mget(...keys: string[]): Promise<(string | null)[]> {
    this.sweepExpired();
    return keys.map((k) => this.kv.get(k)?.value ?? null);
  }

  public async zadd(key: string, score: number, member: string): Promise<number> {
    this.sweepExpired();
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map<string, number>();
      this.zsets.set(key, set);
    }
    const isNew = !set.has(member);
    set.set(member, score);
    return isNew ? 1 : 0;
  }

  public async zrem(key: string, member: string): Promise<number> {
    this.sweepExpired();
    const set = this.zsets.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  public async zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number> {
    this.sweepExpired();
    const set = this.zsets.get(key);
    if (!set) return 0;
    const minNum = min === '-inf' ? -Infinity : Number(min);
    const maxNum = max === '+inf' ? Infinity : Number(max);
    let removed = 0;
    for (const [m, score] of set.entries()) {
      if (score >= minNum && score <= maxNum) {
        set.delete(m);
        removed++;
      }
    }
    return removed;
  }

  public async zcard(key: string): Promise<number> {
    this.sweepExpired();
    return this.zsets.get(key)?.size ?? 0;
  }

  public async zscore(key: string, member: string): Promise<string | null> {
    this.sweepExpired();
    const score = this.zsets.get(key)?.get(member);
    return score !== undefined ? String(score) : null;
  }

  public async pexpire(key: string, ms: number): Promise<number> {
    const now = this.clock();
    if (this.zsets.has(key)) {
      this.zsetExpires.set(key, now + ms);
      return 1;
    }
    const kvEntry = this.kv.get(key);
    if (kvEntry) {
      kvEntry.expiresAt = now + ms;
      return 1;
    }
    return 0;
  }

  public pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const self = this;
    const pipe = {
      zremrangebyscore(key: string, min: number | string, max: number | string) {
        ops.push(() => self.zremrangebyscore(key, min, max));
        return pipe;
      },
      zadd(key: string, score: number, member: string) {
        ops.push(() => self.zadd(key, score, member));
        return pipe;
      },
      zrem(key: string, member: string) {
        ops.push(() => self.zrem(key, member));
        return pipe;
      },
      zcard(key: string) {
        ops.push(() => self.zcard(key));
        return pipe;
      },
      pexpire(key: string, ms: number) {
        ops.push(() => self.pexpire(key, ms));
        return pipe;
      },
      set(key: string, value: string, mode?: 'PX' | 'EX', ttl?: number) {
        ops.push(() => self.set(key, value, mode, ttl));
        return pipe;
      },
      del(...keys: string[]) {
        ops.push(() => self.del(...keys));
        return pipe;
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        const results: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
    return pipe;
  }
}

const JWT_SECRET =
  process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

describe('Redis-Backed Presence with TTL & No Pod-Startup Wipe (M3)', () => {
  const mockPrismaUser = prisma.user as jest.Mocked<typeof prisma.user>;
  const mockPrismaConsultation = prisma.consultation as jest.Mocked<typeof prisma.consultation>;

  let fakeRedis: InMemoryRedisMock;
  let fakeNow: number;

  beforeEach(() => {
    jest.clearAllMocks();
    presenceService.clearMemoryStateForTest();
    fakeNow = Date.now();
    fakeRedis = new InMemoryRedisMock();
    fakeRedis.clock = () => fakeNow;
    setSharedRedisClient(fakeRedis as any);
  });

  afterEach(() => {
    setSharedRedisClient(null);
    presenceService.clearMemoryStateForTest();
  });

  it('does NOT wipe DB isOnline on pod startup and does NOT write DB on socket auth or vet connect/disconnect', async () => {
    const prevRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = '';
    setSharedRedisClient(null);
    const httpServer = createServer();
    const io = initializeSocketServer(httpServer);
    await whenSocketRedisReady();
    setSharedRedisClient(fakeRedis as any);
    await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    const vetUser = {
      id: 'vet-presence-1',
      email: 'vet@huellicam.com',
      firstName: 'Ana',
      lastName: 'Lopez',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      tokenVersion: 1,
      deletedAt: null,
    };
    const adminUser = {
      ...vetUser,
      id: 'admin-presence-1',
      role: Role.ADMIN,
      vetStatus: null,
    };

    const vetToken = jwt.sign(
      { userId: vetUser.id, role: vetUser.role, tokenVersion: 1 },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );
    const adminToken = jwt.sign(
      { userId: adminUser.id, role: adminUser.role, tokenVersion: 1 },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );

    (mockPrismaUser.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id === vetUser.id) return vetUser as any;
      if (where.id === adminUser.id) return adminUser as any;
      return null;
    });

    let adminSocket: ClientSocket | undefined;
    let vetSocket1: ClientSocket | undefined;
    let vetSocket2: ClientSocket | undefined;

    try {
      expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();

      const presenceEvents: Array<{ vetId: string; isOnline: boolean }> = [];

      adminSocket = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${adminToken}` },
          transports: ['websocket'],
        });
        s.on('vet:presence', (ev) => presenceEvents.push(ev));
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      // Connect 1st tab for vet -> emits vet:presence { isOnline: true }
      vetSocket1 = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${vetToken}` },
          transports: ['websocket'],
        });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      await new Promise((r) => setTimeout(r, 60));
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
      expect(mockPrismaUser.updateMany).not.toHaveBeenCalled();
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(1);
      expect(presenceEvents.some((e) => e.vetId === vetUser.id && e.isOnline === true)).toBe(
        true
      );

      // Connect 2nd tab for same vet -> no duplicate offline/online flap
      const countBeforeSecondTab = presenceEvents.length;
      vetSocket2 = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${vetToken}` },
          transports: ['websocket'],
        });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(presenceEvents.length).toBe(countBeforeSecondTab);

      // Disconnect 1st tab -> vet remains online because 2nd tab is connected
      await new Promise<void>((resolve) => {
        vetSocket1!.once('disconnect', () => resolve());
        vetSocket1!.disconnect();
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(1);
      expect(presenceEvents.some((e) => e.vetId === vetUser.id && e.isOnline === false)).toBe(
        false
      );

      // Heartbeat event refreshes TTL without emitting duplicate vet:presence
      const ack = await new Promise<{ ok: boolean; expiresAt?: number }>((resolve) => {
        vetSocket2!.emit('presence:heartbeat', (res: any) => resolve(res));
      });
      expect(ack.ok).toBe(true);
      expect(typeof ack.expiresAt).toBe('number');
      expect(presenceEvents.some((e) => e.vetId === vetUser.id && e.isOnline === false)).toBe(
        false
      );

      // Disconnect 2nd (last) tab -> vet goes offline and emits vet:presence { isOnline: false }
      await new Promise<void>((resolve) => {
        vetSocket2!.once('disconnect', () => resolve());
        vetSocket2!.disconnect();
      });
      await new Promise((r) => setTimeout(r, 60));
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(0);
      expect(presenceEvents.some((e) => e.vetId === vetUser.id && e.isOnline === false)).toBe(
        true
      );
      expect(mockPrismaUser.update).not.toHaveBeenCalled();
    } finally {
      if (prevRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = prevRedisUrl;
      }
      adminSocket?.disconnect();
      vetSocket1?.disconnect();
      vetSocket2?.disconnect();
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('expires crashed-pod vet presence automatically after PRESENCE_TTL_MS without disconnect', async () => {
    await presenceService.registerSocketConnect({
      userId: 'vet-crashed-1',
      socketId: 'sock-1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      now: fakeNow,
    });

    expect(await presenceService.getOnlineVetsCount(fakeNow)).toBe(1);
    const snapBefore = await presenceService.getUsersPresence(['vet-crashed-1'], fakeNow);
    expect(snapBefore.get('vet-crashed-1')?.isOnline).toBe(true);

    // Refresh at +60s keeps vet alive past +90s
    fakeNow += 60_000;
    await presenceService.refreshSocketPresence({
      userId: 'vet-crashed-1',
      socketId: 'sock-1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      now: fakeNow,
    });
    fakeNow += 40_000; // 100s since connect, 40s since refresh
    expect(await presenceService.getOnlineVetsCount(fakeNow)).toBe(1);

    // Advance past 90s TTL without heartbeat -> crashed pod vet is auto-pruned
    fakeNow += PRESENCE_TTL_MS + 1;
    expect(await presenceService.getOnlineVetsCount(fakeNow)).toBe(0);
    const snapAfter = await presenceService.getUsersPresence(['vet-crashed-1'], fakeNow);
    expect(snapAfter.get('vet-crashed-1')?.isOnline).toBe(false);
  });

  it('honors manual vet unavailable toggle across socket heartbeats and reconnects', async () => {
    const usersService = new UsersService();
    const vetId = 'vet-manual-1';

    await presenceService.registerSocketConnect({
      userId: vetId,
      socketId: 'sock-v1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      now: fakeNow,
    });
    expect(await presenceService.getOnlineVetsCount(fakeNow)).toBe(1);

    mockPrismaUser.update.mockResolvedValue({
      id: vetId,
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      isOnline: false,
      lastSeen: new Date(fakeNow),
    } as any);

    await usersService.updateProfile(vetId, { isOnline: false });
    expect(await presenceService.getOnlineVetsCount(fakeNow)).toBe(0);

    // Heartbeat or reconnect MUST NOT override manual offline flag
    await presenceService.refreshSocketPresence({
      userId: vetId,
      socketId: 'sock-v1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      now: fakeNow + 5_000,
    });
    const reconnectRes = await presenceService.registerSocketConnect({
      userId: vetId,
      socketId: 'sock-v2',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      now: fakeNow + 10_000,
    });
    expect(reconnectRes.isOnline).toBe(false);
    expect(reconnectRes.transitionedOnline).toBe(false);
    expect(await presenceService.getOnlineVetsCount(fakeNow + 10_000)).toBe(0);

    // Re-enabling availability clears the override
    mockPrismaUser.update.mockResolvedValue({
      id: vetId,
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      isOnline: true,
      lastSeen: new Date(fakeNow + 15_000),
    } as any);
    await usersService.updateProfile(vetId, { isOnline: true });
    expect(await presenceService.getOnlineVetsCount(fakeNow + 15_000)).toBe(1);
    expect(await fakeRedis.zscore(VETS_ONLINE_KEY, vetId)).not.toBeNull();
  });

  it('overlays live Redis presence in AdminService getStats/getUsers/getConsultations and clears on ban/revoke/reject', async () => {
    const adminService = new AdminService();
    await presenceService.registerSocketConnect({
      userId: 'vet-live-1',
      socketId: 'sock-live-1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      now: fakeNow,
    });

    mockPrismaUser.count
      .mockResolvedValueOnce(2) // pending
      .mockResolvedValueOnce(10) // approved
      .mockResolvedValueOnce(1); // rejected
    const stats = await adminService.getStats();
    expect(stats.onlineVets).toBe(1);
    expect(mockPrismaUser.count).toHaveBeenCalledTimes(3); // 4th count came from Redis!

    mockPrismaUser.findMany.mockResolvedValue([
      { id: 'vet-live-1', isOnline: false, lastSeen: null } as any,
      { id: 'vet-off-2', isOnline: true, lastSeen: null } as any,
    ]);
    const users = await adminService.getUsers();
    expect(users[0].isOnline).toBe(true);
    expect(users[1].isOnline).toBe(false);

    mockPrismaConsultation.findMany.mockResolvedValue([
      {
        id: 'cons-1',
        client: { id: 'client-off', isOnline: true, lastSeen: null },
        vet: { id: 'vet-live-1', isOnline: false, lastSeen: null },
      } as any,
    ]);
    const consultations = await adminService.getConsultations();
    expect(consultations[0].client?.isOnline).toBe(false);
    expect(consultations[0].vet?.isOnline).toBe(true);

    // Ban clears Redis presence immediately
    mockPrismaUser.findUnique.mockResolvedValue({
      id: 'vet-live-1',
      email: 'vet@huellicam.com',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
    } as any);
    mockPrismaUser.update.mockResolvedValue({
      id: 'vet-live-1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      isOnline: false,
    } as any);

    await adminService.banUser('admin-1', 'vet-live-1', 'Violation');
    expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(0);
  });

  it('fails fast in production when Redis client is unavailable instead of silently using memory fallback', async () => {
    const savedEnv = { ...process.env };
    setSharedRedisClient(null);
    process.env.NODE_ENV = 'production';
    const prodPresence = new PresenceService();

    try {
      await expect(
        prodPresence.registerSocketConnect({
          userId: 'vet-prod-1',
          socketId: 'sock-p1',
          role: Role.VET,
          vetStatus: VetStatus.APPROVED,
        })
      ).rejects.toThrow(/Redis presence client unavailable in production/);

      await expect(prodPresence.getOnlineVetsCount()).rejects.toThrow(
        /Redis presence client unavailable in production/
      );
    } finally {
      process.env = savedEnv;
    }
  });

  it('prevents heartbeat resurrection after AdminService.rejectVet on a connected APPROVED vet', async () => {
    const prevRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = '';
    setSharedRedisClient(null);
    const httpServer = createServer();
    const io = initializeSocketServer(httpServer);
    await whenSocketRedisReady();
    setSharedRedisClient(fakeRedis as any);
    await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    const vetUser = {
      id: 'vet-reject-live-1',
      email: 'vet-reject@huellicam.com',
      firstName: 'Carlos',
      lastName: 'Gomez',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      tokenVersion: 1,
      deletedAt: null,
      licenseNumber: 'MP-999',
    };
    const adminUser = {
      ...vetUser,
      id: 'admin-reject-1',
      role: Role.ADMIN,
      vetStatus: null,
    };

    const vetToken = jwt.sign(
      { userId: vetUser.id, role: vetUser.role, tokenVersion: 1 },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );
    const adminToken = jwt.sign(
      { userId: adminUser.id, role: adminUser.role, tokenVersion: 1 },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );

    (mockPrismaUser.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id === vetUser.id) return vetUser as any;
      if (where.id === adminUser.id) return adminUser as any;
      return null;
    });
    (mockPrismaUser.findFirst as jest.Mock).mockResolvedValue(vetUser as any);
    (mockPrismaUser.update as jest.Mock).mockResolvedValue({
      ...vetUser,
      vetStatus: VetStatus.REJECTED,
      isOnline: false,
    } as any);

    let adminSocket: ClientSocket | undefined;
    let vetSocket: ClientSocket | undefined;

    try {
      const presenceEvents: Array<{ vetId: string; isOnline: boolean }> = [];
      const terminatedEvents: Array<{ reason: string; message: string }> = [];

      adminSocket = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${adminToken}` },
          transports: ['websocket'],
        });
        s.on('vet:presence', (ev) => presenceEvents.push(ev));
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });

      let vetSocketId = '';
      vetSocket = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${vetToken}` },
          transports: ['websocket'],
        });
        s.on('auth:session_terminated', (ev) => terminatedEvents.push(ev));
        s.once('connect', () => {
          vetSocketId = s.id || '';
          resolve(s);
        });
        s.once('connect_error', reject);
      });

      await new Promise((r) => setTimeout(r, 60));
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(1);

      const adminService = new AdminService();
      const disconnectPromise = new Promise<void>((resolve) => {
        if (!vetSocket!.connected) return resolve();
        vetSocket!.once('disconnect', () => resolve());
      });

      await adminService.rejectVet(vetUser.id, adminUser.id, { reason: 'Matricula invalida' });
      await disconnectPromise;
      await new Promise((r) => setTimeout(r, 50));

      expect(terminatedEvents.some((e) => e.reason === 'VET_REJECTED')).toBe(true);
      expect(presenceEvents.some((e) => e.vetId === vetUser.id && e.isOnline === false)).toBe(
        true
      );
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(0);

      // Simulate an in-flight heartbeat with stale handshake vetStatus -> must NOT resurrect
      await presenceService.refreshSocketPresence({
        userId: vetUser.id,
        socketId: vetSocketId || 'stale-sock',
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        now: Date.now(),
      });
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(0);
      const snap = await presenceService.getUsersPresence([vetUser.id], Date.now());
      expect(snap.get(vetUser.id)?.isOnline).toBe(false);
    } finally {
      if (prevRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = prevRedisUrl;
      }
      adminSocket?.disconnect();
      vetSocket?.disconnect();
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('does not leave ghost-online presence on rapid connect -> immediate disconnect with async Redis delay', async () => {
    class AsyncDelayRedisMock extends InMemoryRedisMock {
      constructor(private delayMs: number) {
        super();
      }
      override async get(key: string): Promise<string | null> {
        await new Promise((r) => setTimeout(r, this.delayMs));
        return super.get(key);
      }
      override async zscore(key: string, member: string): Promise<string | null> {
        await new Promise((r) => setTimeout(r, this.delayMs));
        return super.zscore(key, member);
      }
      override pipeline() {
        const basePipe = super.pipeline();
        const origExec = basePipe.exec.bind(basePipe);
        basePipe.exec = async () => {
          await new Promise((r) => setTimeout(r, this.delayMs));
          return origExec();
        };
        return basePipe;
      }
    }

    const prevRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = '';
    setSharedRedisClient(null);
    const httpServer = createServer();
    const io = initializeSocketServer(httpServer);
    await whenSocketRedisReady();
    const delayedRedis = new AsyncDelayRedisMock(25);
    setSharedRedisClient(delayedRedis as any);
    await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    const vetUser = {
      id: 'vet-rapid-dc-1',
      email: 'rapid@huellicam.com',
      firstName: 'Rapid',
      lastName: 'Vet',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      tokenVersion: 1,
      deletedAt: null,
    };
    const vetToken = jwt.sign(
      { userId: vetUser.id, role: vetUser.role, tokenVersion: 1 },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );
    (mockPrismaUser.findUnique as jest.Mock).mockResolvedValue(vetUser as any);

    let vetSocket: ClientSocket | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${vetToken}` },
          transports: ['websocket'],
        });
        vetSocket = s;
        s.once('connect', () => {
          s.disconnect();
        });
        s.once('disconnect', () => resolve());
        s.once('connect_error', reject);
      });

      await new Promise((r) => setTimeout(r, 350));
      expect(await presenceService.getOnlineVetsCount(Date.now())).toBe(0);
      const snap = await presenceService.getUsersPresence([vetUser.id], Date.now());
      expect(snap.get(vetUser.id)?.isOnline).toBe(false);
    } finally {
      if (prevRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = prevRedisUrl;
      }
      vetSocket?.disconnect();
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('serializes concurrent registerSocketConnect calls and uses atomic Redis eval when available', async () => {
    class AsyncDelayRedisMock extends InMemoryRedisMock {
      constructor(private delayMs: number) {
        super();
      }
      override async get(key: string): Promise<string | null> {
        await new Promise((r) => setTimeout(r, this.delayMs));
        return super.get(key);
      }
      override async zscore(key: string, member: string): Promise<string | null> {
        await new Promise((r) => setTimeout(r, this.delayMs));
        return super.zscore(key, member);
      }
    }

    const delayedRedis = new AsyncDelayRedisMock(20);
    delayedRedis.clock = () => fakeNow;
    setSharedRedisClient(delayedRedis as any);

    const [r1, r2] = await Promise.all([
      presenceService.registerSocketConnect({
        userId: 'vet-concurrent-1',
        socketId: 'sock-c1',
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        now: fakeNow,
      }),
      presenceService.registerSocketConnect({
        userId: 'vet-concurrent-1',
        socketId: 'sock-c2',
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        now: fakeNow,
      }),
    ]);

    expect([r1.transitionedOnline, r2.transitionedOnline].filter(Boolean)).toHaveLength(1);
    expect(r1.isOnline).toBe(true);
    expect(r2.isOnline).toBe(true);

    // Also verify atomic Lua eval path when redis.eval is present (multi-pod ioredis)
    const evalCalls: unknown[][] = [];
    let vetOnlineInLua = false;
    const luaRedisMock = {
      status: 'ready',
      eval: jest.fn(async (...args: unknown[]) => {
        evalCalls.push(args);
        const transitioned = vetOnlineInLua ? 0 : 1;
        vetOnlineInLua = true;
        return [transitioned, 0, 1];
      }),
    };
    setSharedRedisClient(luaRedisMock as any);

    const [lua1, lua2] = await Promise.all([
      presenceService.registerSocketConnect({
        userId: 'vet-lua-1',
        socketId: 'sock-l1',
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        now: fakeNow,
      }),
      presenceService.registerSocketConnect({
        userId: 'vet-lua-1',
        socketId: 'sock-l2',
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        now: fakeNow,
      }),
    ]);

    expect(evalCalls).toHaveLength(2);
    expect([lua1.transitionedOnline, lua2.transitionedOnline]).toEqual([true, false]);
  });

  it('throttles rapid presence:heartbeat spam within cooldown while honoring first heartbeat', async () => {
    const prevRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = '';
    setSharedRedisClient(null);
    const httpServer = createServer();
    const io = initializeSocketServer(httpServer);
    await whenSocketRedisReady();
    const pipelineSpy = jest.spyOn(fakeRedis, 'pipeline');
    setSharedRedisClient(fakeRedis as any);
    await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
    const port = (httpServer.address() as AddressInfo).port;

    const vetUser = {
      id: 'vet-hb-throttle-1',
      email: 'hb@huellicam.com',
      firstName: 'HB',
      lastName: 'Vet',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      tokenVersion: 1,
      deletedAt: null,
    };
    const vetToken = jwt.sign(
      { userId: vetUser.id, role: vetUser.role, tokenVersion: 1 },
      JWT_SECRET,
      { algorithm: 'HS256' }
    );
    (mockPrismaUser.findUnique as jest.Mock).mockResolvedValue(vetUser as any);

    let vetSocket: ClientSocket | undefined;
    try {
      vetSocket = await new Promise<ClientSocket>((resolve, reject) => {
        const s = Client(`http://localhost:${port}`, {
          auth: { token: `Bearer ${vetToken}` },
          transports: ['websocket'],
        });
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });
      await new Promise((r) => setTimeout(r, 40));
      const pipelinesAfterConnect = pipelineSpy.mock.calls.length;

      const ack1 = await new Promise<{ ok: boolean; expiresAt?: number }>((resolve) => {
        vetSocket!.emit('presence:heartbeat', (res: any) => resolve(res));
      });
      expect(ack1.ok).toBe(true);
      expect(pipelineSpy.mock.calls.length).toBe(pipelinesAfterConnect + 1);

      // Immediate spam within 2s cooldown must NOT trigger extra Redis pipelines
      const ack2 = await new Promise<{ ok: boolean; expiresAt?: number }>((resolve) => {
        vetSocket!.emit('presence:heartbeat', (res: any) => resolve(res));
      });
      const ack3 = await new Promise<{ ok: boolean; expiresAt?: number }>((resolve) => {
        vetSocket!.emit('presence:heartbeat', (res: any) => resolve(res));
      });
      expect(ack2.ok).toBe(true);
      expect(ack3.ok).toBe(true);
      expect(pipelineSpy.mock.calls.length).toBe(pipelinesAfterConnect + 1);
    } finally {
      pipelineSpy.mockRestore();
      if (prevRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = prevRedisUrl;
      }
      vetSocket?.disconnect();
      io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
