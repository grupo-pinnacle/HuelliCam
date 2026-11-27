import { ConsultationStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger, serializeError } from '../lib/logger';
import {
  VET_DISCONNECT_GRACE_MS,
  VET_DISCONNECT_SWEEP_BUFFER_MS,
} from '../contracts/consultation.contract';

export type VetTimeoutHandler = (consultationId: string, disconnectedAt: Date) => Promise<unknown>;
export type ActiveVetConsultationsFinder = (vetId: string) => Promise<Array<{ id: string }>>;

export interface VetDisconnectTrackerOptions {
  graceMs?: number;
  sweepIntervalMs?: number;
  claimLeaseMs?: number;
  findActiveConsultations?: ActiveVetConsultationsFinder;
  onTimeout?: VetTimeoutHandler;
}

interface PendingVetDisconnectEntry {
  disconnectedAt: Date;
  timer: NodeJS.Timeout;
}

export const VET_DISCONNECT_DEADLINES_KEY = 'huellicam:vet_disconnect_deadlines';

// 3-minute grace window + 500ms buffer so checkVetDisconnectTimeout (< 3m) triggers deterministically
const DEFAULT_VET_DISCONNECT_GRACE_MS = VET_DISCONNECT_GRACE_MS + VET_DISCONNECT_SWEEP_BUFFER_MS;
const DEFAULT_SWEEP_INTERVAL_MS = 10_000;
const DEFAULT_CLAIM_LEASE_MS = 60_000;

/**
 * Atomically reads up to 50 expired vet disconnect deadlines with scores and bumps
 * their score to `now + claimLeaseMs` so another backend pod does not claim them
 * concurrently while PostgreSQL timeout transitions are running.
 */
export const CLAIM_EXPIRED_VET_DEADLINES_LUA = `
local now = tonumber(ARGV[1])
local claimUntil = tonumber(ARGV[2])
local entries = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'WITHSCORES', 'LIMIT', 0, 50)
for i = 1, #entries, 2 do
  redis.call('ZADD', KEYS[1], claimUntil, entries[i])
end
return entries
`.trim();

export class VetDisconnectTracker {
  private readonly graceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly claimLeaseMs: number;
  private readonly findActiveConsultations: ActiveVetConsultationsFinder;
  private readonly onTimeout: VetTimeoutHandler;
  private readonly pending = new Map<string, PendingVetDisconnectEntry>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private isSweeping = false;

  constructor(options: VetDisconnectTrackerOptions = {}) {
    const rawGrace = options.graceMs ?? DEFAULT_VET_DISCONNECT_GRACE_MS;
    this.graceMs =
      Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : DEFAULT_VET_DISCONNECT_GRACE_MS;

    const rawSweep = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepIntervalMs =
      Number.isFinite(rawSweep) && rawSweep > 0 ? rawSweep : DEFAULT_SWEEP_INTERVAL_MS;

    const rawLease = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.claimLeaseMs =
      Number.isFinite(rawLease) && rawLease > 0 ? rawLease : DEFAULT_CLAIM_LEASE_MS;

    this.findActiveConsultations =
      options.findActiveConsultations ??
      (async (vetId: string) => {
        if (!prisma.consultation?.findMany) {
          return [];
        }
        return prisma.consultation.findMany({
          where: {
            vetId,
            status: ConsultationStatus.ACTIVE,
            deletedAt: null,
          },
          select: { id: true },
        });
      });

    this.onTimeout =
      options.onTimeout ??
      (async (consultationId: string, disconnectedAt: Date) => {
        const { consultationsService } = await import(
          '../modules/consultations/consultations.service'
        );
        return consultationsService.checkVetDisconnectTimeout(consultationId, disconnectedAt);
      });
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  private getActiveRedis() {
    const client = getRedisClient();
    if (client && (client.status === 'ready' || client.status === 'connect')) {
      return client;
    }
    return null;
  }

  public start(): void {
    if (this.sweepTimer) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredOnce();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  public stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  public clear(): void {
    this.stop();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  public async schedule(vetId: string, disconnectedAt: Date = new Date()): Promise<void> {
    if (!vetId) return;

    const redis = this.getActiveRedis();
    if (redis) {
      try {
        const deadlineMs = disconnectedAt.getTime() + this.graceMs;
        await redis.zadd(VET_DISCONNECT_DEADLINES_KEY, deadlineMs, vetId);
        return;
      } catch (err) {
        logger.warn(
          { vetId, err: serializeError(err) },
          '[VetDisconnectTracker] Failed scheduling Redis ZSET deadline; falling back to local timer'
        );
      }
    }

    this.cancelLocal(vetId);
    const timer = setTimeout(() => {
      const current = this.pending.get(vetId);
      if (!current || current.timer !== timer) {
        return;
      }
      this.pending.delete(vetId);
      void this.handleTimeout(vetId, disconnectedAt);
    }, this.graceMs);

    timer.unref?.();
    this.pending.set(vetId, { disconnectedAt, timer });
  }

  public async cancel(vetId: string): Promise<boolean> {
    if (!vetId) return false;
    let cancelled = this.cancelLocal(vetId);

    const redis = this.getActiveRedis();
    if (redis) {
      try {
        const removed = await redis.zrem(VET_DISCONNECT_DEADLINES_KEY, vetId);
        if (removed > 0) {
          cancelled = true;
        }
      } catch (err) {
        logger.warn(
          { vetId, err: serializeError(err) },
          '[VetDisconnectTracker] Failed removing Redis ZSET deadline'
        );
      }
    }

    return cancelled;
  }

  private cancelLocal(vetId: string): boolean {
    const existing = this.pending.get(vetId);
    if (!existing) {
      return false;
    }
    clearTimeout(existing.timer);
    this.pending.delete(vetId);
    return true;
  }

  public async sweepExpiredOnce(now: number = Date.now()): Promise<number> {
    if (this.isSweeping) {
      return 0;
    }
    const redis = this.getActiveRedis();
    if (!redis) {
      return 0;
    }

    this.isSweeping = true;
    let processed = 0;

    try {
      const claimUntil = now + this.claimLeaseMs;
      let claimed: Array<{ vetId: string; score: number }> = [];

      if (typeof (redis as unknown as { eval?: unknown }).eval === 'function') {
        const rawEntries = (await (
          redis as unknown as {
            eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown>;
          }
        ).eval(
          CLAIM_EXPIRED_VET_DEADLINES_LUA,
          1,
          VET_DISCONNECT_DEADLINES_KEY,
          String(now),
          String(claimUntil)
        )) as string[];

        if (Array.isArray(rawEntries)) {
          for (let i = 0; i + 1 < rawEntries.length; i += 2) {
            const vetId = rawEntries[i];
            const score = Number(rawEntries[i + 1]);
            if (vetId && Number.isFinite(score)) {
              claimed.push({ vetId, score });
            }
          }
        }
      } else if (typeof redis.zrangebyscore === 'function') {
        const rawEntries = await redis.zrangebyscore(
          VET_DISCONNECT_DEADLINES_KEY,
          '-inf',
          now,
          'WITHSCORES',
          'LIMIT',
          0,
          50
        );
        for (let i = 0; i + 1 < rawEntries.length; i += 2) {
          const vetId = rawEntries[i];
          const score = Number(rawEntries[i + 1]);
          if (vetId && Number.isFinite(score)) {
            await redis.zadd(VET_DISCONNECT_DEADLINES_KEY, claimUntil, vetId);
            claimed.push({ vetId, score });
          }
        }
      }

      for (const entry of claimed) {
        const disconnectedAt = new Date(entry.score - this.graceMs);
        const completed = await this.handleTimeout(entry.vetId, disconnectedAt);
        if (completed) {
          await redis.zrem(VET_DISCONNECT_DEADLINES_KEY, entry.vetId).catch(() => {});
          processed++;
        }
      }
    } catch (err) {
      logger.warn(
        { err: serializeError(err) },
        '[VetDisconnectTracker] Failed sweeping expired Redis vet disconnect deadlines'
      );
    } finally {
      this.isSweeping = false;
    }

    return processed;
  }

  private async handleTimeout(vetId: string, disconnectedAt: Date): Promise<boolean> {
    try {
      const activeConsultations = await this.findActiveConsultations(vetId);
      let allSucceeded = true;
      for (const consultation of activeConsultations) {
        try {
          await this.onTimeout(consultation.id, disconnectedAt);
        } catch (err) {
          allSucceeded = false;
          logger.warn(
            { vetId, consultationId: consultation.id, err: serializeError(err) },
            '[VetDisconnectTracker] Failed checkVetDisconnectTimeout'
          );
        }
      }
      return allSucceeded;
    } catch (err) {
      logger.warn(
        { vetId, err: serializeError(err) },
        '[VetDisconnectTracker] Failed loading active consultations'
      );
      return false;
    }
  }
}

export const vetDisconnectTracker = new VetDisconnectTracker();
