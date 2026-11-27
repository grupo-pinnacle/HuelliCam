import type Redis from 'ioredis';
import { Role, VetStatus } from '@prisma/client';
import { config } from '../config/env';
import { getRedisClient } from '../lib/redis';

export const PRESENCE_TTL_MS = 90_000;
export const LAST_SEEN_TTL_SEC = 604_800; // 7 days
export const MANUAL_UNAVAILABLE_TTL_SEC = 86_400; // 24 hours
export const VETS_ONLINE_KEY = 'presence:vets:online';

export interface PresenceSocketParams {
  userId: string;
  socketId: string;
  role: Role | string;
  vetStatus?: VetStatus | string | null;
  now?: number;
}

export interface ManualAvailabilityParams {
  userId: string;
  role: Role | string;
  vetStatus?: VetStatus | string | null;
  isOnline: boolean;
  now?: number;
}

export interface UserPresenceSnapshot {
  isOnline: boolean;
  lastSeen: Date | null;
}

interface StoredPresenceState {
  isOnline: boolean;
  lastSeen: string;
  role: string | null;
  vetStatus: string | null;
  expiresAt?: number;
}

const userSocketsKey = (userId: string) => `presence:user:${userId}:sockets`;
const userStateKey = (userId: string) => `presence:user:${userId}`;
const vetUnavailableKey = (userId: string) => `presence:vet:unavailable:${userId}`;

const REGISTER_SOCKET_CONNECT_LUA = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local socketId = ARGV[3]
local presenceTtlMs = tonumber(ARGV[4])
local lastSeenTtlSec = tonumber(ARGV[5])
local approvedVet = ARGV[6] == '1'
local stateOnline = ARGV[7]
local stateOffline = ARGV[8]
local userId = ARGV[9]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], expiresAt, socketId)
redis.call('PEXPIRE', KEYS[1], presenceTtlMs)

local isUnavailable = 0
local transitionedOnline = 0
local effectiveIsOnline = 1

if approvedVet then
  local unavail = redis.call('GET', KEYS[3])
  if unavail == '1' then
    isUnavailable = 1
    effectiveIsOnline = 0
  else
    redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
    local prevScore = redis.call('ZSCORE', KEYS[2], userId)
    if not prevScore or tonumber(prevScore) <= now then
      transitionedOnline = 1
    end
    redis.call('ZADD', KEYS[2], expiresAt, userId)
  end
end

if effectiveIsOnline == 1 then
  redis.call('SET', KEYS[4], stateOnline, 'PX', presenceTtlMs)
else
  redis.call('SET', KEYS[4], stateOffline, 'EX', lastSeenTtlSec)
end

return { transitionedOnline, isUnavailable, effectiveIsOnline }
`.trim();

const REFRESH_SOCKET_PRESENCE_LUA = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local socketId = ARGV[3]
local presenceTtlMs = tonumber(ARGV[4])
local approvedVet = ARGV[5] == '1'
local stateOnline = ARGV[6]
local userId = ARGV[7]

local existingScore = redis.call('ZSCORE', KEYS[1], socketId)
if not existingScore or tonumber(existingScore) <= now then
  return { 0, 0 }
end

local effectiveIsOnline = 1
if approvedVet then
  local unavail = redis.call('GET', KEYS[3])
  if unavail == '1' then
    effectiveIsOnline = 0
  end
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], expiresAt, socketId)
redis.call('PEXPIRE', KEYS[1], presenceTtlMs)

if approvedVet and effectiveIsOnline == 1 then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  redis.call('ZADD', KEYS[2], expiresAt, userId)
end

if effectiveIsOnline == 1 then
  redis.call('SET', KEYS[4], stateOnline, 'PX', presenceTtlMs)
end

return { 1, effectiveIsOnline }
`.trim();

const UNREGISTER_SOCKET_DISCONNECT_LUA = `
local now = tonumber(ARGV[1])
local socketId = ARGV[2]
local lastSeenTtlSec = tonumber(ARGV[3])
local approvedVet = ARGV[4] == '1'
local stateOffline = ARGV[5]
local userId = ARGV[6]

redis.call('ZREM', KEYS[1], socketId)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

local remaining = tonumber(redis.call('ZCARD', KEYS[1]))
if remaining > 0 then
  return { 0, 0 }
end

local wasOnlineVet = 0
if approvedVet then
  local prevScore = redis.call('ZSCORE', KEYS[2], userId)
  if prevScore and tonumber(prevScore) > now then
    wasOnlineVet = 1
  end
  redis.call('ZREM', KEYS[2], userId)
end

redis.call('SET', KEYS[3], stateOffline, 'EX', lastSeenTtlSec)
return { 1, wasOnlineVet }
`.trim();

export class PresenceService {
  // In-memory fallback (STRICTLY limited to non-production when Redis is absent; lazy-pruned, 0 timers)
  private memUserSockets = new Map<string, Map<string, number>>();
  private memVetsOnline = new Map<string, number>();
  private memUserStates = new Map<string, StoredPresenceState>();
  private memVetUnavailable = new Map<string, number>();
  private userLocks = new Map<string, Promise<void>>();

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.userLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.userLocks.set(userId, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.userLocks.get(userId) === tail) {
        this.userLocks.delete(userId);
      }
    }
  }

  private isProduction(): boolean {
    return (process.env.NODE_ENV || config.NODE_ENV) === 'production';
  }

  private getActiveRedis(requireInProd = true): Redis | null {
    const client = getRedisClient();
    if (client && (client.status === 'ready' || client.status === 'connect')) {
      return client;
    }
    if (requireInProd && this.isProduction()) {
      throw new Error('Redis presence client unavailable in production');
    }
    return null;
  }

  public isDistributedActive(): boolean {
    const client = getRedisClient();
    return Boolean(client && (client.status === 'ready' || client.status === 'connect'));
  }

  private isApprovedVet(role: Role | string, vetStatus?: VetStatus | string | null): boolean {
    return role === Role.VET && vetStatus === VetStatus.APPROVED;
  }

  private pruneMemUserSockets(userId: string, now: number): Map<string, number> {
    let sockets = this.memUserSockets.get(userId);
    if (!sockets) {
      sockets = new Map<string, number>();
      this.memUserSockets.set(userId, sockets);
      return sockets;
    }
    for (const [sid, exp] of sockets.entries()) {
      if (exp <= now) {
        sockets.delete(sid);
      }
    }
    return sockets;
  }

  private pruneMemVetsOnline(now: number): void {
    for (const [vetId, exp] of this.memVetsOnline.entries()) {
      if (exp <= now) {
        this.memVetsOnline.delete(vetId);
      }
    }
  }

  private isMemVetUnavailable(userId: string, now: number): boolean {
    const exp = this.memVetUnavailable.get(userId);
    if (!exp) return false;
    if (exp <= now) {
      this.memVetUnavailable.delete(userId);
      return false;
    }
    return true;
  }

  public async registerSocketConnect(params: PresenceSocketParams): Promise<{
    transitionedOnline: boolean;
    isOnline: boolean;
    lastSeen: string;
    expiresAt: number;
  }> {
    return this.withUserLock(params.userId, async () => {
      const now = params.now ?? Date.now();
      const expiresAt = now + PRESENCE_TTL_MS;
      const lastSeen = new Date(now).toISOString();
      const approvedVet = this.isApprovedVet(params.role, params.vetStatus);
      const redis = this.getActiveRedis(true);

      if (redis) {
        if (typeof (redis as unknown as { eval?: unknown }).eval === 'function') {
          const stateOnline = JSON.stringify({
            isOnline: true,
            lastSeen,
            role: String(params.role),
            vetStatus: params.vetStatus ?? null,
          });
          const stateOffline = JSON.stringify({
            isOnline: false,
            lastSeen,
            role: String(params.role),
            vetStatus: params.vetStatus ?? null,
          });

          const rawResult = (await (
            redis as unknown as {
              eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown>;
            }
          ).eval(
            REGISTER_SOCKET_CONNECT_LUA,
            4,
            userSocketsKey(params.userId),
            VETS_ONLINE_KEY,
            vetUnavailableKey(params.userId),
            userStateKey(params.userId),
            String(now),
            String(expiresAt),
            params.socketId,
            String(PRESENCE_TTL_MS),
            String(LAST_SEEN_TTL_SEC),
            approvedVet ? '1' : '0',
            stateOnline,
            stateOffline,
            params.userId
          )) as [number, number, number];

          const transitionedOnline = Number(rawResult?.[0] ?? 0) === 1;
          const effectiveIsOnline = Number(rawResult?.[2] ?? 1) === 1;

          return {
            transitionedOnline,
            isOnline: effectiveIsOnline,
            lastSeen,
            expiresAt,
          };
        }

        const [wasVetScore, unavailableFlag] = approvedVet
          ? await Promise.all([
              redis.zscore(VETS_ONLINE_KEY, params.userId),
              redis.get(vetUnavailableKey(params.userId)),
            ])
          : [null, null];

        const isUnavailable = unavailableFlag === '1';
        const wasOnlineVet = wasVetScore !== null && Number(wasVetScore) > now;
        const effectiveIsOnline = approvedVet ? !isUnavailable : true;

        const statePayload = JSON.stringify({
          isOnline: effectiveIsOnline,
          lastSeen,
          role: String(params.role),
          vetStatus: params.vetStatus ?? null,
        });

        const pipe = redis.pipeline();
        pipe.zremrangebyscore(userSocketsKey(params.userId), '-inf', now);
        pipe.zadd(userSocketsKey(params.userId), expiresAt, params.socketId);
        pipe.pexpire(userSocketsKey(params.userId), PRESENCE_TTL_MS);

        if (approvedVet && !isUnavailable) {
          pipe.zremrangebyscore(VETS_ONLINE_KEY, '-inf', now);
          pipe.zadd(VETS_ONLINE_KEY, expiresAt, params.userId);
        }

        if (effectiveIsOnline) {
          pipe.set(userStateKey(params.userId), statePayload, 'PX', PRESENCE_TTL_MS);
        } else {
          pipe.set(userStateKey(params.userId), statePayload, 'EX', LAST_SEEN_TTL_SEC);
        }

        await pipe.exec();

        return {
          transitionedOnline: approvedVet && !isUnavailable && !wasOnlineVet,
          isOnline: effectiveIsOnline,
          lastSeen,
          expiresAt,
        };
      }

      // In-memory non-production fallback
      this.pruneMemVetsOnline(now);
      const sockets = this.pruneMemUserSockets(params.userId, now);
      const wasOnlineVet = approvedVet && (this.memVetsOnline.get(params.userId) ?? 0) > now;
      const isUnavailable = approvedVet && this.isMemVetUnavailable(params.userId, now);
      const effectiveIsOnline = approvedVet ? !isUnavailable : true;

      sockets.set(params.socketId, expiresAt);
      if (approvedVet && !isUnavailable) {
        this.memVetsOnline.set(params.userId, expiresAt);
      }

      this.memUserStates.set(params.userId, {
        isOnline: effectiveIsOnline,
        lastSeen,
        role: String(params.role),
        vetStatus: params.vetStatus ?? null,
        expiresAt: effectiveIsOnline ? expiresAt : now + LAST_SEEN_TTL_SEC * 1000,
      });

      return {
        transitionedOnline: approvedVet && !isUnavailable && !wasOnlineVet,
        isOnline: effectiveIsOnline,
        lastSeen,
        expiresAt,
      };
    });
  }

  public async refreshSocketPresence(params: PresenceSocketParams): Promise<{
    isOnline: boolean;
    lastSeen: string;
    expiresAt: number;
  }> {
    return this.withUserLock(params.userId, async () => {
      const now = params.now ?? Date.now();
      const expiresAt = now + PRESENCE_TTL_MS;
      const lastSeen = new Date(now).toISOString();
      const approvedVet = this.isApprovedVet(params.role, params.vetStatus);
      const redis = this.getActiveRedis(true);

      if (redis) {
        if (typeof (redis as unknown as { eval?: unknown }).eval === 'function') {
          const stateOnline = JSON.stringify({
            isOnline: true,
            lastSeen,
            role: String(params.role),
            vetStatus: params.vetStatus ?? null,
          });
          const rawResult = (await (
            redis as unknown as {
              eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown>;
            }
          ).eval(
            REFRESH_SOCKET_PRESENCE_LUA,
            4,
            userSocketsKey(params.userId),
            VETS_ONLINE_KEY,
            vetUnavailableKey(params.userId),
            userStateKey(params.userId),
            String(now),
            String(expiresAt),
            params.socketId,
            String(PRESENCE_TTL_MS),
            approvedVet ? '1' : '0',
            stateOnline,
            params.userId
          )) as [number, number];

          const socketActive = Number(rawResult?.[0] ?? 0) === 1;
          if (!socketActive) {
            return { isOnline: false, lastSeen, expiresAt };
          }
          const effectiveIsOnline = Number(rawResult?.[1] ?? 1) === 1;
          return { isOnline: effectiveIsOnline, lastSeen, expiresAt };
        }

        const [existingSocketScore, unavailableFlag] = await Promise.all([
          redis.zscore(userSocketsKey(params.userId), params.socketId),
          approvedVet ? redis.get(vetUnavailableKey(params.userId)) : Promise.resolve(null),
        ]);

        // Never resurrect an evicted/cleared or expired socket
        if (existingSocketScore === null || Number(existingSocketScore) <= now) {
          return { isOnline: false, lastSeen, expiresAt };
        }

        const isUnavailable = unavailableFlag === '1';
        const effectiveIsOnline = approvedVet ? !isUnavailable : true;

        const pipe = redis.pipeline();
        pipe.zremrangebyscore(userSocketsKey(params.userId), '-inf', now);
        pipe.zadd(userSocketsKey(params.userId), expiresAt, params.socketId);
        pipe.pexpire(userSocketsKey(params.userId), PRESENCE_TTL_MS);

        if (approvedVet && !isUnavailable) {
          pipe.zremrangebyscore(VETS_ONLINE_KEY, '-inf', now);
          pipe.zadd(VETS_ONLINE_KEY, expiresAt, params.userId);
        }

        if (effectiveIsOnline) {
          pipe.set(
            userStateKey(params.userId),
            JSON.stringify({
              isOnline: true,
              lastSeen,
              role: String(params.role),
              vetStatus: params.vetStatus ?? null,
            }),
            'PX',
            PRESENCE_TTL_MS
          );
        }

        await pipe.exec();

        return { isOnline: effectiveIsOnline, lastSeen, expiresAt };
      }

      this.pruneMemVetsOnline(now);
      const sockets = this.pruneMemUserSockets(params.userId, now);
      if (!sockets.has(params.socketId)) {
        return { isOnline: false, lastSeen, expiresAt };
      }

      const isUnavailable = approvedVet && this.isMemVetUnavailable(params.userId, now);
      const effectiveIsOnline = approvedVet ? !isUnavailable : true;

      sockets.set(params.socketId, expiresAt);
      if (approvedVet && !isUnavailable) {
        this.memVetsOnline.set(params.userId, expiresAt);
      }

      if (effectiveIsOnline) {
        this.memUserStates.set(params.userId, {
          isOnline: true,
          lastSeen,
          role: String(params.role),
          vetStatus: params.vetStatus ?? null,
          expiresAt,
        });
      }

      return { isOnline: effectiveIsOnline, lastSeen, expiresAt };
    });
  }

  public async unregisterSocketDisconnect(params: PresenceSocketParams): Promise<{
    wentOffline: boolean;
    wasOnlineVet: boolean;
    lastSeen: string;
  }> {
    return this.withUserLock(params.userId, async () => {
      const now = params.now ?? Date.now();
      const lastSeen = new Date(now).toISOString();
      const approvedVet = this.isApprovedVet(params.role, params.vetStatus);
      const redis = this.getActiveRedis(false);

      if (redis) {
        if (typeof (redis as unknown as { eval?: unknown }).eval === 'function') {
          const stateOffline = JSON.stringify({
            isOnline: false,
            lastSeen,
            role: String(params.role),
            vetStatus: params.vetStatus ?? null,
          });
          const rawResult = (await (
            redis as unknown as {
              eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown>;
            }
          ).eval(
            UNREGISTER_SOCKET_DISCONNECT_LUA,
            3,
            userSocketsKey(params.userId),
            VETS_ONLINE_KEY,
            userStateKey(params.userId),
            String(now),
            params.socketId,
            String(LAST_SEEN_TTL_SEC),
            approvedVet ? '1' : '0',
            stateOffline,
            params.userId
          )) as [number, number];

          return {
            wentOffline: Number(rawResult?.[0] ?? 0) === 1,
            wasOnlineVet: Number(rawResult?.[1] ?? 0) === 1,
            lastSeen,
          };
        }

        const pipe = redis.pipeline();
        pipe.zrem(userSocketsKey(params.userId), params.socketId);
        pipe.zremrangebyscore(userSocketsKey(params.userId), '-inf', now);
        pipe.zcard(userSocketsKey(params.userId));
        const results = await pipe.exec();

        const remaining = Number(results?.[2]?.[1] ?? 0);
        if (remaining > 0) {
          return { wentOffline: false, wasOnlineVet: false, lastSeen };
        }

        const wasVetScore = approvedVet ? await redis.zscore(VETS_ONLINE_KEY, params.userId) : null;
        const wasOnlineVet = wasVetScore !== null && Number(wasVetScore) > now;

        const offlinePipe = redis.pipeline();
        if (approvedVet) {
          offlinePipe.zrem(VETS_ONLINE_KEY, params.userId);
        }
        offlinePipe.set(
          userStateKey(params.userId),
          JSON.stringify({
            isOnline: false,
            lastSeen,
            role: String(params.role),
            vetStatus: params.vetStatus ?? null,
          }),
          'EX',
          LAST_SEEN_TTL_SEC
        );
        await offlinePipe.exec();

        return { wentOffline: true, wasOnlineVet, lastSeen };
      }

      if (this.isProduction()) {
        return { wentOffline: true, wasOnlineVet: false, lastSeen };
      }

      this.pruneMemVetsOnline(now);
      const sockets = this.pruneMemUserSockets(params.userId, now);
      sockets.delete(params.socketId);
      if (sockets.size > 0) {
        return { wentOffline: false, wasOnlineVet: false, lastSeen };
      }
      this.memUserSockets.delete(params.userId);

      const wasOnlineVet = approvedVet && (this.memVetsOnline.get(params.userId) ?? 0) > now;
      if (approvedVet) {
        this.memVetsOnline.delete(params.userId);
      }

      this.memUserStates.set(params.userId, {
        isOnline: false,
        lastSeen,
        role: String(params.role),
        vetStatus: params.vetStatus ?? null,
        expiresAt: now + LAST_SEEN_TTL_SEC * 1000,
      });

      return { wentOffline: true, wasOnlineVet, lastSeen };
    });
  }

  public async setManualVetAvailability(params: ManualAvailabilityParams): Promise<{
    isOnline: boolean;
    lastSeen: string;
  }> {
    return this.withUserLock(params.userId, async () => {
      const now = params.now ?? Date.now();
      const expiresAt = now + PRESENCE_TTL_MS;
      const lastSeen = new Date(now).toISOString();
      const approvedVet = this.isApprovedVet(params.role, params.vetStatus);
      const redis = this.getActiveRedis(true);

      if (redis) {
        const pipe = redis.pipeline();
        if (!params.isOnline) {
          pipe.set(vetUnavailableKey(params.userId), '1', 'EX', MANUAL_UNAVAILABLE_TTL_SEC);
          pipe.zrem(VETS_ONLINE_KEY, params.userId);
          pipe.set(
            userStateKey(params.userId),
            JSON.stringify({
              isOnline: false,
              lastSeen,
              role: String(params.role),
              vetStatus: params.vetStatus ?? null,
            }),
            'EX',
            LAST_SEEN_TTL_SEC
          );
        } else {
          pipe.del(vetUnavailableKey(params.userId));
          if (approvedVet) {
            pipe.zremrangebyscore(VETS_ONLINE_KEY, '-inf', now);
            pipe.zadd(VETS_ONLINE_KEY, expiresAt, params.userId);
          }
          pipe.set(
            userStateKey(params.userId),
            JSON.stringify({
              isOnline: true,
              lastSeen,
              role: String(params.role),
              vetStatus: params.vetStatus ?? null,
            }),
            'PX',
            PRESENCE_TTL_MS
          );
        }
        await pipe.exec();
        return { isOnline: params.isOnline, lastSeen };
      }

      this.pruneMemVetsOnline(now);
      if (!params.isOnline) {
        this.memVetUnavailable.set(params.userId, now + MANUAL_UNAVAILABLE_TTL_SEC * 1000);
        this.memVetsOnline.delete(params.userId);
        this.memUserStates.set(params.userId, {
          isOnline: false,
          lastSeen,
          role: String(params.role),
          vetStatus: params.vetStatus ?? null,
          expiresAt: now + LAST_SEEN_TTL_SEC * 1000,
        });
      } else {
        this.memVetUnavailable.delete(params.userId);
        if (approvedVet) {
          this.memVetsOnline.set(params.userId, expiresAt);
        }
        this.memUserStates.set(params.userId, {
          isOnline: true,
          lastSeen,
          role: String(params.role),
          vetStatus: params.vetStatus ?? null,
          expiresAt,
        });
      }

      return { isOnline: params.isOnline, lastSeen };
    });
  }

  public async clearUserPresence(userId: string, now = Date.now()): Promise<void> {
    return this.withUserLock(userId, async () => {
      const lastSeen = new Date(now).toISOString();
      const redis = this.getActiveRedis(false);

      if (redis) {
        const pipe = redis.pipeline();
        pipe.del(userSocketsKey(userId));
        pipe.del(vetUnavailableKey(userId));
        pipe.zrem(VETS_ONLINE_KEY, userId);
        pipe.set(
          userStateKey(userId),
          JSON.stringify({
            isOnline: false,
            lastSeen,
            role: null,
            vetStatus: null,
          }),
          'EX',
          LAST_SEEN_TTL_SEC
        );
        await pipe.exec();
        return;
      }

      this.memUserSockets.delete(userId);
      this.memVetUnavailable.delete(userId);
      this.memVetsOnline.delete(userId);
      this.memUserStates.set(userId, {
        isOnline: false,
        lastSeen,
        role: null,
        vetStatus: null,
        expiresAt: now + LAST_SEEN_TTL_SEC * 1000,
      });
    });
  }

  public async removeVetFromOnline(vetId: string, now = Date.now()): Promise<void> {
    return this.withUserLock(vetId, async () => {
      const lastSeen = new Date(now).toISOString();
      const redis = this.getActiveRedis(false);

      if (redis) {
        const pipe = redis.pipeline();
        pipe.del(userSocketsKey(vetId));
        pipe.zrem(VETS_ONLINE_KEY, vetId);
        pipe.set(
          userStateKey(vetId),
          JSON.stringify({
            isOnline: false,
            lastSeen,
            role: Role.VET,
            vetStatus: VetStatus.REJECTED,
          }),
          'EX',
          LAST_SEEN_TTL_SEC
        );
        await pipe.exec();
        return;
      }

      this.memUserSockets.delete(vetId);
      this.memVetsOnline.delete(vetId);
      this.memUserStates.set(vetId, {
        isOnline: false,
        lastSeen,
        role: Role.VET,
        vetStatus: VetStatus.REJECTED,
        expiresAt: now + LAST_SEEN_TTL_SEC * 1000,
      });
    });
  }

  public async getOnlineVetsCount(now = Date.now()): Promise<number> {
    const redis = this.getActiveRedis(true);
    if (redis) {
      await redis.zremrangebyscore(VETS_ONLINE_KEY, '-inf', now);
      return redis.zcard(VETS_ONLINE_KEY);
    }

    this.pruneMemVetsOnline(now);
    return this.memVetsOnline.size;
  }

  public async getUsersPresence(
    userIds: string[],
    now = Date.now()
  ): Promise<Map<string, UserPresenceSnapshot>> {
    const result = new Map<string, UserPresenceSnapshot>();
    const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
      return result;
    }

    const redis = this.getActiveRedis(true);
    if (redis) {
      const rawValues = await redis.mget(...uniqueIds.map((id) => userStateKey(id)));
      uniqueIds.forEach((id, index) => {
        const raw = rawValues[index];
        if (!raw) {
          result.set(id, { isOnline: false, lastSeen: null });
          return;
        }
        try {
          const parsed = JSON.parse(raw) as StoredPresenceState;
          const parsedDate = parsed.lastSeen ? new Date(parsed.lastSeen) : null;
          result.set(id, {
            isOnline: Boolean(parsed.isOnline),
            lastSeen: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
          });
        } catch {
          result.set(id, { isOnline: false, lastSeen: null });
        }
      });
      return result;
    }

    for (const id of uniqueIds) {
      const state = this.memUserStates.get(id);
      if (!state) {
        result.set(id, { isOnline: false, lastSeen: null });
        continue;
      }
      const isExpired = state.expiresAt !== undefined && state.expiresAt <= now;
      const parsedDate = state.lastSeen ? new Date(state.lastSeen) : null;
      result.set(id, {
        isOnline: isExpired ? false : Boolean(state.isOnline),
        lastSeen: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      });
    }

    return result;
  }

  public clearMemoryStateForTest(): void {
    this.memUserSockets.clear();
    this.memVetsOnline.clear();
    this.memUserStates.clear();
    this.memVetUnavailable.clear();
  }
}

export const presenceService = new PresenceService();
