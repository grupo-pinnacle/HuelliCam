import { setSharedRedisClient } from '../lib/redis';
import {
  CLAIM_EXPIRED_VET_DEADLINES_LUA,
  VET_DISCONNECT_DEADLINES_KEY,
  VetDisconnectTracker,
} from '../realtime/vetDisconnectTracker';

describe('VetDisconnectTracker (Redis ZSET & Local Fallback)', () => {
  afterEach(() => {
    setSharedRedisClient(null);
    jest.clearAllMocks();
  });

  it('schedules and cancels deadlines in Redis ZSET and reconstructs disconnectedAt WITHSCORES', async () => {
    const zset = new Map<string, number>();
    const fakeRedis = {
      status: 'ready',
      zadd: jest.fn(async (_key: string, score: number, member: string) => {
        zset.set(member, score);
        return 1;
      }),
      zrem: jest.fn(async (_key: string, member: string) => (zset.delete(member) ? 1 : 0)),
      eval: jest.fn(async (script: string, _numKeys: number, ...args: string[]) => {
        expect(script).toBe(CLAIM_EXPIRED_VET_DEADLINES_LUA);
        const now = Number(args[1]);
        const claimUntil = Number(args[2]);
        const result: string[] = [];
        for (const [member, score] of zset.entries()) {
          if (score <= now) {
            result.push(member, String(score));
            zset.set(member, claimUntil);
          }
        }
        return result;
      }),
    };

    setSharedRedisClient(fakeRedis as unknown as Parameters<typeof setSharedRedisClient>[0]);

    const findActive = jest.fn().mockResolvedValue([{ id: 'cons-active-1' }]);
    const onTimeout = jest.fn().mockResolvedValue({ id: 'cons-active-1', status: 'CANCELLED' });
    const tracker = new VetDisconnectTracker({
      graceMs: 180_500,
      findActiveConsultations: findActive,
      onTimeout,
    });

    const t0 = 1_700_000_000_000;
    const disconnectedAt = new Date(t0);

    await tracker.schedule('vet-reconnect', disconnectedAt);
    expect(zset.get('vet-reconnect')).toBe(t0 + 180_500);
    expect(await tracker.cancel('vet-reconnect')).toBe(true);
    expect(zset.has('vet-reconnect')).toBe(false);

    await tracker.schedule('vet-expired', disconnectedAt);
    expect(fakeRedis.zadd).toHaveBeenCalledWith(
      VET_DISCONNECT_DEADLINES_KEY,
      t0 + 180_500,
      'vet-expired'
    );

    const beforeDeadline = await tracker.sweepExpiredOnce(t0 + 100_000);
    expect(beforeDeadline).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();

    const afterDeadline = await tracker.sweepExpiredOnce(t0 + 180_501);
    expect(afterDeadline).toBe(1);
    expect(findActive).toHaveBeenCalledWith('vet-expired');
    expect(onTimeout).toHaveBeenCalledWith('cons-active-1', disconnectedAt);
    expect(fakeRedis.zrem).toHaveBeenCalledWith(VET_DISCONNECT_DEADLINES_KEY, 'vet-expired');
    expect(zset.has('vet-expired')).toBe(false);

    tracker.clear();
  });

  it('retains ZSET lease claim when DB check throws so another sweep can retry', async () => {
    const zset = new Map<string, number>();
    const fakeRedis = {
      status: 'ready',
      zadd: jest.fn(async (_key: string, score: number, member: string) => {
        zset.set(member, score);
        return 1;
      }),
      zrem: jest.fn(async (_key: string, member: string) => (zset.delete(member) ? 1 : 0)),
      eval: jest.fn(async (_script: string, _numKeys: number, ...args: string[]) => {
        const now = Number(args[1]);
        const claimUntil = Number(args[2]);
        const result: string[] = [];
        for (const [member, score] of zset.entries()) {
          if (score <= now) {
            result.push(member, String(score));
            zset.set(member, claimUntil);
          }
        }
        return result;
      }),
    };
    setSharedRedisClient(fakeRedis as unknown as Parameters<typeof setSharedRedisClient>[0]);

    const tracker = new VetDisconnectTracker({
      graceMs: 1_000,
      claimLeaseMs: 5_000,
      findActiveConsultations: jest.fn().mockRejectedValue(new Error('DB temporarily unavailable')),
      onTimeout: jest.fn(),
    });

    const t0 = 1_700_000_000_000;
    await tracker.schedule('vet-db-err', new Date(t0));
    const processed = await tracker.sweepExpiredOnce(t0 + 2_000);
    expect(processed).toBe(0);
    // Entry remains bumped in ZSET (+5000ms lease) instead of being lost via premature ZREM
    expect(zset.get('vet-db-err')).toBe(t0 + 2_000 + 5_000);
    expect(fakeRedis.zrem).not.toHaveBeenCalled();

    tracker.clear();
  });
});
