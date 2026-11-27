import crypto from 'crypto';
import { ConsultationStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger, serializeError } from '../lib/logger';

const SWEEP_INTERVAL_MS = 60_000;
const TRIAGE_TIMEOUT_MS = 15 * 60 * 1000;
const LOCK_KEY = 'huellicam:lock:triage_timeout_sweeper';
const LOCK_TTL_MS = 55_000;

let sweeperTimer: NodeJS.Timeout | null = null;
let lastSweepAt: string | null = null;
let lastExpiredCount = 0;

export function getTriageSweeperStatus() {
  return {
    running: Boolean(sweeperTimer),
    lastSweepAt,
    lastExpiredCount,
  };
}

export async function runTriageTimeoutSweep(now: Date = new Date()): Promise<number> {
  if (!prisma.consultation?.findMany) return 0;

  const redis = getRedisClient();
  const lockToken = crypto.randomUUID();
  let acquiredRedisLock = false;

  if (redis && redis.status === 'ready') {
    try {
      const ok = await redis.set(LOCK_KEY, lockToken, 'PX', LOCK_TTL_MS, 'NX');
      if (ok !== 'OK') {
        return 0;
      }
      acquiredRedisLock = true;
    } catch {
      // Proceed cleanly when Redis is unavailable in local dev
    }
  }

  try {
    const cutoff = new Date(now.getTime() - TRIAGE_TIMEOUT_MS);
    const candidates = await prisma.consultation.findMany({
      where: {
        status: ConsultationStatus.WAITING,
        deletedAt: null,
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        notes: true,
        stateVersion: true,
        activeDeviceId: true,
      },
      take: 50,
    });

    if (candidates.length === 0) {
      lastSweepAt = now.toISOString();
      lastExpiredCount = 0;
      return 0;
    }

    // Do not auto-expire future scheduled appointments
    const scheduledIds = new Set<string>();
    if (prisma.consultationMetadata?.findMany) {
      const metas = await prisma.consultationMetadata.findMany({
        where: {
          consultationId: { in: candidates.map((c) => c.id) },
          scheduledAt: { gt: cutoff },
        },
        select: { consultationId: true },
      });
      metas.forEach((m) => scheduledIds.add(m.consultationId));
    }

    let expiredCount = 0;
    for (const c of candidates) {
      if (scheduledIds.has(c.id)) continue;

      const updatedNotes = c.notes
        ? `${c.notes} [CANCELLED_TIMEOUT_NO_VET_AVAILABLE]`
        : '[CANCELLED_TIMEOUT_NO_VET_AVAILABLE]';

      const cas = await prisma.consultation.updateMany({
        where: {
          id: c.id,
          status: ConsultationStatus.WAITING,
          deletedAt: null,
        },
        data: {
          status: ConsultationStatus.CANCELLED,
          endedAt: now,
          stateVersion: { increment: 1 },
          notes: updatedNotes,
        },
      });

      if (cas.count > 0) {
        expiredCount += 1;
        if (prisma.consultationAuditLog?.create) {
          await prisma.consultationAuditLog
            .create({
              data: {
                consultationId: c.id,
                eventType: 'TIMEOUT_TRIAGE',
                previousState: ConsultationStatus.WAITING,
                newState: ConsultationStatus.CANCELLED,
                actorId: null,
                deviceId: c.activeDeviceId ?? null,
                metadata: { stateVersion: Number(c.stateVersion ?? 1) + 1, source: 'triageTimeoutSweeper' },
              },
            })
            .catch(() => {});
        }
      }
    }

    lastSweepAt = now.toISOString();
    lastExpiredCount = expiredCount;
    return expiredCount;
  } catch (err) {
    logger.warn({ err: serializeError(err) }, '[TriageTimeoutSweeper] Sweep cycle failed');
    return 0;
  } finally {
    if (acquiredRedisLock && redis && redis.status === 'ready') {
      await redis.del(LOCK_KEY).catch(() => {});
    }
  }
}

export function startTriageTimeoutSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    void runTriageTimeoutSweep();
  }, SWEEP_INTERVAL_MS);
}

export function stopTriageTimeoutSweeper(): void {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}
