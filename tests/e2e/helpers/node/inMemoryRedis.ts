import { EventEmitter } from 'events';

export interface RedisCommandEntry {
  cmd: string;
  args: unknown[];
  timestamp: number;
}

export interface PresenceEntry {
  key: string;
  kind: 'kv' | 'set' | 'hash' | 'zset';
  ttlMs: number | null;
  size: number;
  value?: string;
}

interface StoredKv {
  value: string;
  expiresAt: number | null;
}

interface StoredSet {
  members: Set<string>;
  expiresAt: number | null;
}

interface StoredHash {
  fields: Map<string, string>;
  expiresAt: number | null;
}

interface StoredZSet {
  members: Map<string, number>;
  expiresAt: number | null;
}

interface ScoreBound {
  value: number;
  exclusive: boolean;
}

function parseScoreBound(raw: string | number): ScoreBound {
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower === '-inf') return { value: -Infinity, exclusive: false };
  if (lower === '+inf' || lower === 'inf') return { value: Infinity, exclusive: false };
  if (s.startsWith('(')) {
    return { value: Number(s.slice(1)), exclusive: true };
  }
  return { value: Number(s), exclusive: false };
}

function inScoreRange(score: number, min: ScoreBound, max: ScoreBound): boolean {
  const geMin = min.exclusive ? score > min.value : score >= min.value;
  const leMax = max.exclusive ? score < max.value : score <= max.value;
  return geMin && leMax;
}

export class SharedInMemoryRedisState {
  public kv = new Map<string, StoredKv>();
  public sets = new Map<string, StoredSet>();
  public hashes = new Map<string, StoredHash>();
  public zsets = new Map<string, StoredZSet>();
  public commands: RedisCommandEntry[] = [];
  public nowOffsetMs = 0;

  public now(): number {
    return Date.now() + this.nowOffsetMs;
  }

  public advanceTime(ms: number): void {
    this.nowOffsetMs += ms;
    this.pruneExpired();
  }

  public pruneExpired(): void {
    const t = this.now();
    for (const [key, entry] of this.kv.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= t) {
        this.kv.delete(key);
      }
    }
    for (const [key, entry] of this.sets.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= t) {
        this.sets.delete(key);
      }
    }
    for (const [key, entry] of this.hashes.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= t) {
        this.hashes.delete(key);
      }
    }
    for (const [key, entry] of this.zsets.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= t) {
        this.zsets.delete(key);
      }
    }
  }

  public getPresenceEntries(): PresenceEntry[] {
    this.pruneExpired();
    const t = this.now();
    const results: PresenceEntry[] = [];

    for (const [key, entry] of this.kv.entries()) {
      if (/^presence:/i.test(key)) {
        results.push({
          key,
          kind: 'kv',
          ttlMs: entry.expiresAt !== null ? Math.max(0, entry.expiresAt - t) : null,
          size: 1,
          value: entry.value,
        });
      }
    }
    for (const [key, entry] of this.sets.entries()) {
      if (/^presence:/i.test(key) && entry.members.size > 0) {
        results.push({
          key,
          kind: 'set',
          ttlMs: entry.expiresAt !== null ? Math.max(0, entry.expiresAt - t) : null,
          size: entry.members.size,
        });
      }
    }
    for (const [key, entry] of this.hashes.entries()) {
      if (/^presence:/i.test(key) && entry.fields.size > 0) {
        results.push({
          key,
          kind: 'hash',
          ttlMs: entry.expiresAt !== null ? Math.max(0, entry.expiresAt - t) : null,
          size: entry.fields.size,
        });
      }
    }
    for (const [key, entry] of this.zsets.entries()) {
      if (/^presence:/i.test(key) && entry.members.size > 0) {
        results.push({
          key,
          kind: 'zset',
          ttlMs: entry.expiresAt !== null ? Math.max(0, entry.expiresAt - t) : null,
          size: entry.members.size,
        });
      }
    }

    return results;
  }

  public getPresenceCommands(cmdFilter?: string[]): RedisCommandEntry[] {
    return this.commands.filter((entry) => {
      if (cmdFilter && !cmdFilter.includes(entry.cmd)) return false;
      return entry.args.some((arg) => typeof arg === 'string' && /presence:/i.test(arg));
    });
  }
}

export function createInMemoryRedisMock() {
  const state = new SharedInMemoryRedisState();

  class FakeRedis extends EventEmitter {
    public status = 'ready';
    public options: Record<string, unknown>;

    constructor(_url?: string | Record<string, unknown>, opts?: Record<string, unknown>) {
      super();
      this.options = {
        retryStrategy: (t: number) => Math.min(100 * 2 ** (t - 1), 10000),
        ...(typeof _url === 'object' && _url !== null ? _url : {}),
        ...(opts ?? {}),
      };
    }

    private record(cmd: string, args: unknown[]): void {
      state.commands.push({ cmd, args, timestamp: state.now() });
    }

    public async connect(): Promise<void> {
      this.record('connect', []);
      this.status = 'ready';
      this.emit('connect');
      this.emit('ready');
    }

    public duplicate(overrides?: Record<string, unknown>): FakeRedis {
      return new FakeRedis(undefined, { ...this.options, ...(overrides ?? {}) });
    }

    public async ping(): Promise<string> {
      this.record('ping', []);
      return 'PONG';
    }

    public async psubscribe(...channels: string[]): Promise<number> {
      this.record('psubscribe', channels);
      return channels.length;
    }

    public async subscribe(...channels: string[]): Promise<number> {
      this.record('subscribe', channels);
      return channels.length;
    }

    public async punsubscribe(...channels: string[]): Promise<number> {
      this.record('punsubscribe', channels);
      return 0;
    }

    public async unsubscribe(...channels: string[]): Promise<number> {
      this.record('unsubscribe', channels);
      return 0;
    }

    public async publish(channel: string, message: string): Promise<number> {
      this.record('publish', [channel, message]);
      return 1;
    }

    public async set(key: string, value: string | number, ...args: unknown[]): Promise<string | null> {
      state.pruneExpired();
      this.record('set', [key, value, ...args]);

      let expiresAt: number | null = null;
      let onlyIfNotExists = false;
      let onlyIfExists = false;
      let keepTtl = false;

      for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i]).toUpperCase();
        if (token === 'EX' && i + 1 < args.length) {
          expiresAt = state.now() + Number(args[i + 1]) * 1000;
          i += 1;
        } else if (token === 'PX' && i + 1 < args.length) {
          expiresAt = state.now() + Number(args[i + 1]);
          i += 1;
        } else if (token === 'EXAT' && i + 1 < args.length) {
          expiresAt = Number(args[i + 1]) * 1000;
          i += 1;
        } else if (token === 'PXAT' && i + 1 < args.length) {
          expiresAt = Number(args[i + 1]);
          i += 1;
        } else if (token === 'NX') {
          onlyIfNotExists = true;
        } else if (token === 'XX') {
          onlyIfExists = true;
        } else if (token === 'KEEPTTL') {
          keepTtl = true;
        }
      }

      const existing = state.kv.get(key);
      if (onlyIfNotExists && existing) return null;
      if (onlyIfExists && !existing) return null;

      state.kv.set(key, {
        value: String(value),
        expiresAt: keepTtl && existing ? existing.expiresAt : expiresAt,
      });
      return 'OK';
    }

    public async setex(key: string, seconds: number, value: string | number): Promise<string> {
      this.record('setex', [key, seconds, value]);
      state.kv.set(key, {
        value: String(value),
        expiresAt: state.now() + Number(seconds) * 1000,
      });
      return 'OK';
    }

    public async psetex(key: string, ms: number, value: string | number): Promise<string> {
      this.record('psetex', [key, ms, value]);
      state.kv.set(key, {
        value: String(value),
        expiresAt: state.now() + Number(ms),
      });
      return 'OK';
    }

    public async get(key: string): Promise<string | null> {
      state.pruneExpired();
      this.record('get', [key]);
      return state.kv.get(key)?.value ?? null;
    }

    public async mget(...keys: string[]): Promise<Array<string | null>> {
      state.pruneExpired();
      this.record('mget', keys);
      return keys.map((k) => state.kv.get(k)?.value ?? null);
    }

    public async expire(key: string, seconds: number): Promise<number> {
      state.pruneExpired();
      this.record('expire', [key, seconds]);
      const expiresAt = state.now() + Number(seconds) * 1000;
      let hit = false;
      const kvEntry = state.kv.get(key);
      if (kvEntry) {
        kvEntry.expiresAt = expiresAt;
        hit = true;
      }
      const setEntry = state.sets.get(key);
      if (setEntry) {
        setEntry.expiresAt = expiresAt;
        hit = true;
      }
      const hashEntry = state.hashes.get(key);
      if (hashEntry) {
        hashEntry.expiresAt = expiresAt;
        hit = true;
      }
      const zsetEntry = state.zsets.get(key);
      if (zsetEntry) {
        zsetEntry.expiresAt = expiresAt;
        hit = true;
      }
      return hit ? 1 : 0;
    }

    public async pexpire(key: string, ms: number): Promise<number> {
      state.pruneExpired();
      this.record('pexpire', [key, ms]);
      const expiresAt = state.now() + Number(ms);
      let hit = false;
      const kvEntry = state.kv.get(key);
      if (kvEntry) {
        kvEntry.expiresAt = expiresAt;
        hit = true;
      }
      const setEntry = state.sets.get(key);
      if (setEntry) {
        setEntry.expiresAt = expiresAt;
        hit = true;
      }
      const hashEntry = state.hashes.get(key);
      if (hashEntry) {
        hashEntry.expiresAt = expiresAt;
        hit = true;
      }
      const zsetEntry = state.zsets.get(key);
      if (zsetEntry) {
        zsetEntry.expiresAt = expiresAt;
        hit = true;
      }
      return hit ? 1 : 0;
    }

    public async ttl(key: string): Promise<number> {
      state.pruneExpired();
      this.record('ttl', [key]);
      const entry =
        state.kv.get(key) ?? state.sets.get(key) ?? state.hashes.get(key) ?? state.zsets.get(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((entry.expiresAt - state.now()) / 1000));
    }

    public async pttl(key: string): Promise<number> {
      state.pruneExpired();
      this.record('pttl', [key]);
      const entry =
        state.kv.get(key) ?? state.sets.get(key) ?? state.hashes.get(key) ?? state.zsets.get(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.max(0, entry.expiresAt - state.now());
    }

    public async del(...keys: string[]): Promise<number> {
      this.record('del', keys);
      let removed = 0;
      for (const k of keys) {
        if (state.kv.delete(k)) removed += 1;
        if (state.sets.delete(k)) removed += 1;
        if (state.hashes.delete(k)) removed += 1;
        if (state.zsets.delete(k)) removed += 1;
      }
      return removed;
    }

    public async unlink(...keys: string[]): Promise<number> {
      return this.del(...keys);
    }

    public async exists(...keys: string[]): Promise<number> {
      state.pruneExpired();
      this.record('exists', keys);
      let count = 0;
      for (const k of keys) {
        if (state.kv.has(k) || state.sets.has(k) || state.hashes.has(k) || state.zsets.has(k)) {
          count += 1;
        }
      }
      return count;
    }

    public async keys(pattern: string): Promise<string[]> {
      state.pruneExpired();
      this.record('keys', [pattern]);
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
      );
      const allKeys = new Set([
        ...state.kv.keys(),
        ...state.sets.keys(),
        ...state.hashes.keys(),
        ...state.zsets.keys(),
      ]);
      return Array.from(allKeys).filter((k) => regex.test(k));
    }

    public async sadd(key: string, ...members: string[]): Promise<number> {
      state.pruneExpired();
      this.record('sadd', [key, ...members]);
      let entry = state.sets.get(key);
      if (!entry) {
        entry = { members: new Set<string>(), expiresAt: null };
        state.sets.set(key, entry);
      }
      let added = 0;
      for (const m of members) {
        const s = String(m);
        if (!entry.members.has(s)) {
          entry.members.add(s);
          added += 1;
        }
      }
      return added;
    }

    public async srem(key: string, ...members: string[]): Promise<number> {
      state.pruneExpired();
      this.record('srem', [key, ...members]);
      const entry = state.sets.get(key);
      if (!entry) return 0;
      let removed = 0;
      for (const m of members) {
        if (entry.members.delete(String(m))) removed += 1;
      }
      if (entry.members.size === 0) {
        state.sets.delete(key);
      }
      return removed;
    }

    public async scard(key: string): Promise<number> {
      state.pruneExpired();
      this.record('scard', [key]);
      return state.sets.get(key)?.members.size ?? 0;
    }

    public async smembers(key: string): Promise<string[]> {
      state.pruneExpired();
      this.record('smembers', [key]);
      return Array.from(state.sets.get(key)?.members ?? []);
    }

    public async sismember(key: string, member: string): Promise<number> {
      state.pruneExpired();
      this.record('sismember', [key, member]);
      return state.sets.get(key)?.members.has(String(member)) ? 1 : 0;
    }

    public async hset(key: string, ...args: unknown[]): Promise<number> {
      state.pruneExpired();
      this.record('hset', [key, ...args]);
      let entry = state.hashes.get(key);
      if (!entry) {
        entry = { fields: new Map<string, string>(), expiresAt: null };
        state.hashes.set(key, entry);
      }
      let added = 0;
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        for (const [fk, fv] of Object.entries(args[0] as Record<string, unknown>)) {
          if (!entry.fields.has(fk)) added += 1;
          entry.fields.set(fk, String(fv));
        }
      } else {
        for (let i = 0; i + 1 < args.length; i += 2) {
          const fk = String(args[i]);
          const fv = String(args[i + 1]);
          if (!entry.fields.has(fk)) added += 1;
          entry.fields.set(fk, fv);
        }
      }
      return added;
    }

    public async hget(key: string, field: string): Promise<string | null> {
      state.pruneExpired();
      this.record('hget', [key, field]);
      return state.hashes.get(key)?.fields.get(String(field)) ?? null;
    }

    public async hgetall(key: string): Promise<Record<string, string>> {
      state.pruneExpired();
      this.record('hgetall', [key]);
      const entry = state.hashes.get(key);
      if (!entry) return {};
      return Object.fromEntries(entry.fields.entries());
    }

    public async hdel(key: string, ...fields: string[]): Promise<number> {
      state.pruneExpired();
      this.record('hdel', [key, ...fields]);
      const entry = state.hashes.get(key);
      if (!entry) return 0;
      let removed = 0;
      for (const f of fields) {
        if (entry.fields.delete(String(f))) removed += 1;
      }
      return removed;
    }

    public async zadd(key: string, ...args: unknown[]): Promise<number> {
      state.pruneExpired();
      this.record('zadd', [key, ...args]);

      let nx = false;
      let xx = false;
      let gt = false;
      let lt = false;
      let ch = false;
      let idx = 0;

      while (idx < args.length) {
        const flag = String(args[idx]).toUpperCase();
        if (flag === 'NX') {
          nx = true;
          idx += 1;
        } else if (flag === 'XX') {
          xx = true;
          idx += 1;
        } else if (flag === 'GT') {
          gt = true;
          idx += 1;
        } else if (flag === 'LT') {
          lt = true;
          idx += 1;
        } else if (flag === 'CH') {
          ch = true;
          idx += 1;
        } else {
          break;
        }
      }

      let entry = state.zsets.get(key);
      if (!entry) {
        entry = { members: new Map<string, number>(), expiresAt: null };
        state.zsets.set(key, entry);
      }

      let added = 0;
      let changed = 0;
      for (; idx + 1 < args.length; idx += 2) {
        const score = Number(args[idx]);
        const member = String(args[idx + 1]);
        if (Number.isNaN(score)) continue;

        const existingScore = entry.members.get(member);
        if (existingScore === undefined) {
          if (xx) continue;
          entry.members.set(member, score);
          added += 1;
          changed += 1;
        } else {
          if (nx) continue;
          if (gt && score <= existingScore) continue;
          if (lt && score >= existingScore) continue;
          if (existingScore !== score) {
            entry.members.set(member, score);
            changed += 1;
          }
        }
      }

      if (entry.members.size === 0) {
        state.zsets.delete(key);
      }

      return ch ? changed : added;
    }

    public async zrem(key: string, ...members: string[]): Promise<number> {
      state.pruneExpired();
      this.record('zrem', [key, ...members]);
      const entry = state.zsets.get(key);
      if (!entry) return 0;
      let removed = 0;
      for (const m of members) {
        if (entry.members.delete(String(m))) removed += 1;
      }
      if (entry.members.size === 0) {
        state.zsets.delete(key);
      }
      return removed;
    }

    public async zscore(key: string, member: string): Promise<string | null> {
      state.pruneExpired();
      this.record('zscore', [key, member]);
      const score = state.zsets.get(key)?.members.get(String(member));
      return score === undefined ? null : String(score);
    }

    public async zcard(key: string): Promise<number> {
      state.pruneExpired();
      this.record('zcard', [key]);
      return state.zsets.get(key)?.members.size ?? 0;
    }

    public async zremrangebyscore(
      key: string,
      min: string | number,
      max: string | number
    ): Promise<number> {
      state.pruneExpired();
      this.record('zremrangebyscore', [key, min, max]);
      const entry = state.zsets.get(key);
      if (!entry) return 0;

      const minBound = parseScoreBound(min);
      const maxBound = parseScoreBound(max);
      let removed = 0;

      for (const [member, score] of entry.members.entries()) {
        if (inScoreRange(score, minBound, maxBound)) {
          entry.members.delete(member);
          removed += 1;
        }
      }

      if (entry.members.size === 0) {
        state.zsets.delete(key);
      }
      return removed;
    }

    public async zrangebyscore(
      key: string,
      min: string | number,
      max: string | number,
      ...args: unknown[]
    ): Promise<string[]> {
      state.pruneExpired();
      this.record('zrangebyscore', [key, min, max, ...args]);
      const entry = state.zsets.get(key);
      if (!entry) return [];

      const minBound = parseScoreBound(min);
      const maxBound = parseScoreBound(max);

      let withScores = false;
      let offset = 0;
      let count = Infinity;
      for (let i = 0; i < args.length; i += 1) {
        const token = String(args[i]).toUpperCase();
        if (token === 'WITHSCORES') {
          withScores = true;
        } else if (token === 'LIMIT' && i + 2 < args.length) {
          offset = Math.max(0, Number(args[i + 1]));
          const rawCount = Number(args[i + 2]);
          count = rawCount < 0 ? Infinity : rawCount;
          i += 2;
        }
      }

      const matching = Array.from(entry.members.entries())
        .filter(([, score]) => inScoreRange(score, minBound, maxBound))
        .sort((a, b) => (a[1] !== b[1] ? a[1] - b[1] : a[0].localeCompare(b[0])))
        .slice(offset, count === Infinity ? undefined : offset + count);

      if (!withScores) {
        return matching.map(([member]) => member);
      }

      const out: string[] = [];
      for (const [member, score] of matching) {
        out.push(member, String(score));
      }
      return out;
    }

    public async eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown> {
      this.record('eval', [script, numKeys, ...args]);
      const keys = args.slice(0, numKeys).map(String);
      const argv = args.slice(numKeys).map(String);

      // REGISTER_SOCKET_CONNECT_LUA (backend/src/realtime/presence.service.ts)
      if (
        /ZREMRANGEBYSCORE/i.test(script) &&
        /ZADD/i.test(script) &&
        /PEXPIRE/i.test(script) &&
        keys.length >= 4 &&
        argv.length >= 9
      ) {
        const now = Number(argv[0]);
        const expiresAt = Number(argv[1]);
        const socketId = argv[2];
        const presenceTtlMs = Number(argv[3]);
        const lastSeenTtlSec = Number(argv[4]);
        const approvedVet = argv[5] === '1';
        const stateOnline = argv[6];
        const stateOffline = argv[7];
        const userId = argv[8];

        await this.zremrangebyscore(keys[0], '-inf', now);
        await this.zadd(keys[0], expiresAt, socketId);
        await this.pexpire(keys[0], presenceTtlMs);

        let isUnavailable = 0;
        let transitionedOnline = 0;
        let effectiveIsOnline = 1;

        if (approvedVet) {
          const unavail = await this.get(keys[2]);
          if (unavail === '1') {
            isUnavailable = 1;
            effectiveIsOnline = 0;
          } else {
            await this.zremrangebyscore(keys[1], '-inf', now);
            const prevScore = await this.zscore(keys[1], userId);
            if (prevScore === null || Number(prevScore) <= now) {
              transitionedOnline = 1;
            }
            await this.zadd(keys[1], expiresAt, userId);
          }
        }

        if (effectiveIsOnline === 1) {
          await this.set(keys[3], stateOnline, 'PX', presenceTtlMs);
        } else {
          await this.set(keys[3], stateOffline, 'EX', lastSeenTtlSec);
        }

        return [transitionedOnline, isUnavailable, effectiveIsOnline];
      }

      if (/SADD/i.test(script) && keys[0] && argv[0]) {
        await this.sadd(keys[0], argv[0]);
        if (/EXPIRE/i.test(script) && argv[1] && Number(argv[1]) > 0) {
          await this.expire(keys[0], Number(argv[1]));
        }
        return this.scard(keys[0]);
      }
      if (/SREM/i.test(script) && keys[0] && argv[0]) {
        await this.srem(keys[0], argv[0]);
        return this.scard(keys[0]);
      }
      return 1;
    }

    public multi() {
      const queued: Array<() => Promise<unknown>> = [];
      const self = this;
      const chain: Record<string, (...args: unknown[]) => unknown> = {
        get: (...args: unknown[]) => {
          queued.push(() => self.get(...(args as [string])));
          return chain;
        },
        mget: (...args: unknown[]) => {
          queued.push(() => self.mget(...(args as string[])));
          return chain;
        },
        set: (...args: unknown[]) => {
          queued.push(() => self.set(...(args as [string, string | number, ...unknown[]])));
          return chain;
        },
        setex: (...args: unknown[]) => {
          queued.push(() => self.setex(...(args as [string, number, string | number])));
          return chain;
        },
        expire: (...args: unknown[]) => {
          queued.push(() => self.expire(...(args as [string, number])));
          return chain;
        },
        pexpire: (...args: unknown[]) => {
          queued.push(() => self.pexpire(...(args as [string, number])));
          return chain;
        },
        del: (...args: unknown[]) => {
          queued.push(() => self.del(...(args as string[])));
          return chain;
        },
        sadd: (...args: unknown[]) => {
          queued.push(() => self.sadd(...(args as [string, ...string[]])));
          return chain;
        },
        srem: (...args: unknown[]) => {
          queued.push(() => self.srem(...(args as [string, ...string[]])));
          return chain;
        },
        scard: (...args: unknown[]) => {
          queued.push(() => self.scard(...(args as [string])));
          return chain;
        },
        hset: (...args: unknown[]) => {
          queued.push(() => self.hset(...(args as [string, ...unknown[]])));
          return chain;
        },
        hdel: (...args: unknown[]) => {
          queued.push(() => self.hdel(...(args as [string, ...string[]])));
          return chain;
        },
        zadd: (...args: unknown[]) => {
          queued.push(() => self.zadd(...(args as [string, ...unknown[]])));
          return chain;
        },
        zrem: (...args: unknown[]) => {
          queued.push(() => self.zrem(...(args as [string, ...string[]])));
          return chain;
        },
        zscore: (...args: unknown[]) => {
          queued.push(() => self.zscore(...(args as [string, string])));
          return chain;
        },
        zcard: (...args: unknown[]) => {
          queued.push(() => self.zcard(...(args as [string])));
          return chain;
        },
        zremrangebyscore: (...args: unknown[]) => {
          queued.push(() =>
            self.zremrangebyscore(...(args as [string, string | number, string | number]))
          );
          return chain;
        },
        zrangebyscore: (...args: unknown[]) => {
          queued.push(() =>
            self.zrangebyscore(...(args as [string, string | number, string | number, ...unknown[]]))
          );
          return chain;
        },
        eval: (...args: unknown[]) => {
          queued.push(() => self.eval(...(args as [string, number, ...unknown[]])));
          return chain;
        },
        exec: async () => {
          const out: Array<[null, unknown]> = [];
          for (const op of queued) {
            out.push([null, await op()]);
          }
          return out;
        },
      };
      return chain;
    }

    public pipeline() {
      return this.multi();
    }

    public async quit(): Promise<string> {
      this.record('quit', []);
      this.status = 'end';
      return 'OK';
    }

    public disconnect(): void {
      this.record('disconnect', []);
      this.status = 'end';
    }
  }

  return { state, FakeRedis };
}
