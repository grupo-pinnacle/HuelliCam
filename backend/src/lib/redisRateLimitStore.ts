import type { ClientRateLimitInfo, IncrementResponse, Options, Store } from 'express-rate-limit';
import { getRedisClient } from './redis';

interface MemoryBucket {
  hits: number;
  resetAt: number;
}

/**
 * Distributed Store for express-rate-limit backed by ioredis (`INCR` + `PEXPIRE`)
 * with automatic local in-memory fallback when Redis is unavailable or in tests.
 */
export class RedisRateLimitStore implements Store {
  public readonly prefix: string;
  public readonly localKeys = false;
  private windowMs: number;
  private readonly memoryBuckets = new Map<string, MemoryBucket>();
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(prefix: string, defaultWindowMs = 60_000) {
    this.prefix = prefix;
    this.windowMs = defaultWindowMs;
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.memoryBuckets.entries()) {
        if (now >= bucket.resetAt) {
          this.memoryBuckets.delete(key);
        }
      }
    }, 60_000);
    this.pruneTimer.unref?.();
  }

  public init(options: Options): void {
    if (typeof options.windowMs === 'number' && Number.isFinite(options.windowMs) && options.windowMs > 0) {
      this.windowMs = options.windowMs;
    }
  }

  private namespacedKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  public async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        const redisKey = this.namespacedKey(key);
        const [rawHits, rawPttl] = await Promise.all([client.get(redisKey), client.pttl(redisKey)]);
        if (rawHits === null) {
          return undefined;
        }
        const totalHits = Number(rawHits);
        if (!Number.isFinite(totalHits) || totalHits <= 0) {
          return undefined;
        }
        const ttlMs = rawPttl > 0 ? rawPttl : this.windowMs;
        return {
          totalHits,
          resetTime: new Date(Date.now() + ttlMs),
        };
      } catch {
        // Fallback to local memory
      }
    }

    const entry = this.memoryBuckets.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.resetAt) {
      this.memoryBuckets.delete(key);
      return undefined;
    }
    return {
      totalHits: entry.hits,
      resetTime: new Date(entry.resetAt),
    };
  }

  public async increment(key: string): Promise<IncrementResponse> {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        const redisKey = this.namespacedKey(key);
        const totalHits = await client.incr(redisKey);
        let pttl = totalHits === 1 ? -1 : await client.pttl(redisKey);
        if (pttl < 0) {
          await client.pexpire(redisKey, this.windowMs);
          pttl = this.windowMs;
        }
        return {
          totalHits,
          resetTime: new Date(Date.now() + pttl),
        };
      } catch {
        // Fallback to local memory on transient Redis errors
      }
    }

    const now = Date.now();
    const existing = this.memoryBuckets.get(key);
    if (!existing || now >= existing.resetAt) {
      const next: MemoryBucket = { hits: 1, resetAt: now + this.windowMs };
      this.memoryBuckets.set(key, next);
      return {
        totalHits: 1,
        resetTime: new Date(next.resetAt),
      };
    }

    existing.hits += 1;
    return {
      totalHits: existing.hits,
      resetTime: new Date(existing.resetAt),
    };
  }

  public async decrement(key: string): Promise<void> {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        const redisKey = this.namespacedKey(key);
        const next = await client.decr(redisKey);
        if (next <= 0) {
          await client.del(redisKey);
        }
        return;
      } catch {
        // Fallback to local memory
      }
    }

    const existing = this.memoryBuckets.get(key);
    if (!existing) return;
    existing.hits -= 1;
    if (existing.hits <= 0) {
      this.memoryBuckets.delete(key);
    }
  }

  public async resetKey(key: string): Promise<void> {
    this.memoryBuckets.delete(key);
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        await client.del(this.namespacedKey(key));
      } catch {
        // Non-blocking Redis cleanup
      }
    }
  }

  public async resetAll(): Promise<void> {
    this.memoryBuckets.clear();
  }

  public shutdown(): void {
    clearInterval(this.pruneTimer);
    this.memoryBuckets.clear();
  }
}
