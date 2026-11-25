import prisma from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { callsService } from '../calls/calls.service';
import { io } from '../../realtime/socket.server';
import { logger, serializeError } from '../../lib/logger';

export interface ClaimConsultationResult {
  consultationId: string;
  status: string;
  tutorId: string;
  activeDeviceId: string | null;
  transportStatus: string;
  stateVersion: number;
}

export type CasFailureReason = 'CONFLICT' | 'NOT_FOUND' | 'INVALID_STATE';

export interface MigrateSessionResult {
  hasActiveConsultation: boolean;
  ok?: boolean;
  reason?: CasFailureReason;
  consultationId?: string;
  vetId?: string | null;
  revokedDeviceId?: string | null;
  status?: string;
  stateVersion?: number;
}

export interface MarkDisconnectResult {
  updated: boolean;
  rowCount: number;
  ok?: boolean;
  reason?: CasFailureReason;
  consultationId?: string;
  stateVersion?: number;
}

const ACTIVE_CONCURRENCY_STATUSES = [
  'TRIAGE_CRITICAL_QUEUED',
  'CLAIM_PENDING_SYNC',
  'LIVEKIT_CONNECTING',
  'IN_CALL_ACTIVE',
  'WAITING',
] as const;

const CLAIMABLE_STATUSES = [
  'TRIAGE_CRITICAL_QUEUED',
  'HANDOFF_IN_PROGRESS',
  'CLAIM_PENDING_SYNC',
  'WAITING',
] as const;

export interface PostCommitEvictionParams {
  consultationId: string;
  tutorId: string;
  revokedDeviceId?: string | null;
  newDeviceId?: string;
  status: string;
  stateVersion: number;
  vetId?: string | null;
}

let _hasConcurrencyColumns: boolean | null = process.env.NODE_ENV === 'test' ? true : null;

/**
 * Checks if the underlying database schema has the required concurrency columns.
 * Caches the result to avoid repeated introspection overhead.
 * In test environment, defaults to true.
 */
export async function isConcurrencySchemaSupported(): Promise<boolean> {
  if (_hasConcurrencyColumns !== null) return _hasConcurrencyColumns;
  try {
    const result = await prisma.$queryRawUnsafe<any[]>(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'consultations' AND column_name = 'transport_status' LIMIT 1`
    );
    _hasConcurrencyColumns = Array.isArray(result) && result.length > 0;
  } catch {
    _hasConcurrencyColumns = false;
  }
  return _hasConcurrencyColumns;
}

export function setConcurrencySchemaSupportForTest(supported: boolean | null): void {
  _hasConcurrencyColumns = supported;
}

export class ConsultationConcurrencyService {
  /**
   * Veterinarian Claim Transaction (claimConsultationByVet)
   * Uses optimistic stateVersion compare-and-swap (CAS), validates state, and assigns veterinarian.
   * Commutative with tutor migration.
   */
  public async claimConsultationByVet(
    consultationId: string,
    vetId: string
  ): Promise<ClaimConsultationResult> {
    const schemaSupported = await isConcurrencySchemaSupported();
    if (!schemaSupported) {
      const consultation = await prisma.consultation.findUnique({
        where: { id: consultationId },
      });
      if (!consultation) {
        throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
      }
      if (consultation.vetId && consultation.vetId !== vetId) {
        throw new AppError('Consulta ya tomada por otro veterinario', 409, 'CONSULTATION_ALREADY_CLAIMED');
      }
      const allowedStatuses = [
        'TRIAGE_CRITICAL_QUEUED',
        'HANDOFF_IN_PROGRESS',
        'CLAIM_PENDING_SYNC',
        'WAITING',
      ];
      if (!allowedStatuses.includes(consultation.status)) {
        throw new AppError(`Estado ${consultation.status} no valido para ser tomado`, 400, 'INVALID_STATE_FOR_CLAIM');
      }

      const updated = await prisma.consultation.update({
        where: { id: consultationId },
        data: {
          vetId,
          status: 'IN_CALL_ACTIVE' as any,
        },
      });

      return {
        consultationId: updated.id,
        status: updated.status,
        tutorId: updated.clientId,
        activeDeviceId: null,
        transportStatus: 'ONLINE',
        stateVersion: 1,
      };
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Read current consultation snapshot without pessimistic row locks
      const record = await tx.consultation.findUnique({
        where: { id: consultationId },
      });

      if (!record) {
        throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
      }

      const currentVetId = record.vetId ?? null;
      const currentStatus = record.status;
      const currentTransportStatus = record.transportStatus ?? 'OFFLINE';
      const currentStateVersion = Number(record.stateVersion ?? 1);
      const tutorId = record.clientId;
      const activeDeviceId = record.activeDeviceId ?? null;
      const existingClaimedAt = record.claimedAt;

      // 2. Validate state and ownership
      if (currentVetId !== null && currentVetId !== vetId) {
        throw new AppError('Consulta ya tomada por otro veterinario', 409, 'CONSULTATION_ALREADY_CLAIMED');
      }

      if (!CLAIMABLE_STATUSES.includes(currentStatus as (typeof CLAIMABLE_STATUSES)[number])) {
        throw new AppError(`Estado ${currentStatus} no valido para ser tomado`, 400, 'INVALID_STATE_FOR_CLAIM');
      }

      // 3. Compute nextStatus and state version
      const nextStatus = currentTransportStatus === 'ONLINE' ? 'LIVEKIT_CONNECTING' : 'CLAIM_PENDING_SYNC';
      const nextVersion = currentStateVersion + 1;
      const claimedAt = existingClaimedAt ? new Date(existingClaimedAt) : new Date();

      // 4. Optimistic CAS update guarded by stateVersion and preconditions
      const casResult = await tx.consultation.updateMany({
        where: {
          id: consultationId,
          stateVersion: currentStateVersion,
          status: currentStatus as any,
          transportStatus: currentTransportStatus,
          OR: [{ vetId: null }, { vetId }],
        },
        data: {
          vetId,
          status: nextStatus as any,
          stateVersion: nextVersion,
          claimedAt,
        },
      });

      if (casResult.count === 0) {
        const latest = await tx.consultation.findUnique({
          where: { id: consultationId },
        });
        if (latest === null) {
          throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
        }
        if (latest && latest.vetId !== null && latest.vetId !== vetId) {
          throw new AppError('Consulta ya tomada por otro veterinario', 409, 'CONSULTATION_ALREADY_CLAIMED');
        }
        if (
          latest &&
          !CLAIMABLE_STATUSES.includes(latest.status as (typeof CLAIMABLE_STATUSES)[number])
        ) {
          throw new AppError(`Estado ${latest.status} no valido para ser tomado`, 400, 'INVALID_STATE_FOR_CLAIM');
        }
        throw new AppError('Conflicto de concurrencia al tomar la consulta', 409, 'CONFLICT');
      }

      // 5. Insert audit record into consultation_audit_log only after CAS succeeds
      await tx.consultationAuditLog.create({
        data: {
          consultationId,
          eventType: 'VET_CLAIM',
          previousState: currentStatus,
          newState: nextStatus,
          actorId: vetId,
          deviceId: activeDeviceId,
          metadata: {
            previousTransportStatus: currentTransportStatus,
            stateVersion: nextVersion,
          },
        },
      });

      return {
        consultationId,
        status: nextStatus,
        tutorId,
        activeDeviceId,
        transportStatus: currentTransportStatus,
        stateVersion: nextVersion,
      };
    });
  }

  /**
   * Tutor Session Migration Transaction (migrateTutorSession)
   * Invoked when tutor opens socket connection or logs in from a new device during active session.
   * Commutative with vet claim via optimistic CAS.
   */
  public async migrateTutorSession(
    tutorId: string,
    newDeviceId: string
  ): Promise<MigrateSessionResult> {
    const schemaSupported = await isConcurrencySchemaSupported();
    if (!schemaSupported) {
      return { hasActiveConsultation: false };
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Find active consultation without pessimistic row locks
      const record = await tx.consultation.findFirst({
        where: {
          clientId: tutorId,
          status: {
            in: ACTIVE_CONCURRENCY_STATUSES as unknown as any[],
          },
        },
      });

      if (!record) {
        return { hasActiveConsultation: false };
      }

      const consultationId = record.id;
      const currentVetId = record.vetId ?? null;
      const currentStatus = record.status;
      const currentTransportStatus = record.transportStatus ?? 'OFFLINE';
      const previousDeviceId = record.activeDeviceId ?? null;
      const currentStateVersion = Number(record.stateVersion ?? 1);

      // 2. Determine nextConsultationStatus
      const nextConsultationStatus = currentVetId !== null ? 'LIVEKIT_CONNECTING' : 'TRIAGE_CRITICAL_QUEUED';
      const nextVersion = currentStateVersion + 1;
      const revokedDeviceId = previousDeviceId && previousDeviceId !== newDeviceId ? previousDeviceId : null;

      // 3. Optimistic CAS update guarded by stateVersion and preconditions
      const casResult = await tx.consultation.updateMany({
        where: {
          id: consultationId,
          clientId: tutorId,
          stateVersion: currentStateVersion,
          status: currentStatus as any,
          vetId: currentVetId,
        },
        data: {
          activeDeviceId: newDeviceId,
          transportStatus: 'ONLINE',
          status: nextConsultationStatus as any,
          stateVersion: nextVersion,
        },
      });

      if (casResult.count === 0) {
        const latest = await tx.consultation.findUnique({
          where: { id: consultationId },
        });
        if (latest === null) {
          return {
            hasActiveConsultation: false,
            ok: false,
            reason: 'NOT_FOUND',
            consultationId,
          };
        }
        if (
          latest &&
          !ACTIVE_CONCURRENCY_STATUSES.includes(
            latest.status as (typeof ACTIVE_CONCURRENCY_STATUSES)[number]
          )
        ) {
          return {
            hasActiveConsultation: false,
            ok: false,
            reason: 'INVALID_STATE',
            consultationId,
          };
        }
        return {
          hasActiveConsultation: false,
          ok: false,
          reason: 'CONFLICT',
          consultationId,
        };
      }

      // 4. Insert audit log only after CAS succeeds
      await tx.consultationAuditLog.create({
        data: {
          consultationId,
          eventType: 'DEVICE_HANDOFF',
          previousState: currentStatus,
          newState: nextConsultationStatus,
          actorId: tutorId,
          deviceId: newDeviceId,
          metadata: {
            revokedDeviceId,
            previousTransportStatus: currentTransportStatus,
            stateVersion: nextVersion,
          },
        },
      });

      return {
        ok: true,
        hasActiveConsultation: true,
        consultationId,
        vetId: currentVetId,
        revokedDeviceId,
        status: nextConsultationStatus,
        stateVersion: nextVersion,
      };
    });
  }

  /**
   * Atomic Guard on Socket Disconnect (markSocketDisconnect)
   * Only transitions to GRACE_DISCONNECTED if the disconnecting socket
   * matches the consultation's current active_device_id via optimistic CAS.
   */
  public async markSocketDisconnect(
    tutorId: string,
    deviceId: string
  ): Promise<MarkDisconnectResult> {
    const schemaSupported = await isConcurrencySchemaSupported();
    if (!schemaSupported) {
      return { updated: false, rowCount: 0 };
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Query consultation matching tutor and active_device_id without row locks
      const record = await tx.consultation.findFirst({
        where: {
          clientId: tutorId,
          activeDeviceId: deviceId,
          status: {
            in: ACTIVE_CONCURRENCY_STATUSES as unknown as any[],
          },
        },
      });

      if (!record) {
        return { updated: false, rowCount: 0 };
      }

      const consultationId = record.id;
      const currentTransportStatus = record.transportStatus ?? 'ONLINE';
      const currentStateVersion = Number(record.stateVersion ?? 1);
      const nextVersion = currentStateVersion + 1;

      // 2. Optimistic CAS transition to GRACE_DISCONNECTED
      const casResult = await tx.consultation.updateMany({
        where: {
          id: consultationId,
          clientId: tutorId,
          activeDeviceId: deviceId,
          stateVersion: currentStateVersion,
          status: record.status as any,
        },
        data: {
          transportStatus: 'GRACE_DISCONNECTED',
          stateVersion: nextVersion,
        },
      });

      if (casResult.count === 0) {
        const latest = await tx.consultation.findUnique({
          where: { id: consultationId },
        });
        const reason: CasFailureReason =
          latest === null
            ? 'NOT_FOUND'
            : latest &&
                !ACTIVE_CONCURRENCY_STATUSES.includes(
                  latest.status as (typeof ACTIVE_CONCURRENCY_STATUSES)[number]
                )
              ? 'INVALID_STATE'
              : 'CONFLICT';
        return {
          updated: false,
          rowCount: 0,
          ok: false,
          reason,
          consultationId,
        };
      }

      // 3. Record audit log only after CAS succeeds
      await tx.consultationAuditLog.create({
        data: {
          consultationId,
          eventType: 'SOCKET_DISCONNECT',
          previousState: currentTransportStatus,
          newState: 'GRACE_DISCONNECTED',
          actorId: tutorId,
          deviceId,
          metadata: {
            consultationStatus: record.status,
            stateVersion: nextVersion,
          },
        },
      });

      return {
        updated: true,
        rowCount: casResult.count,
        ok: true,
        consultationId,
        stateVersion: nextVersion,
      };
    });
  }

  /**
   * Out-of-Band Post-Commit Eviction & Session Resume Helper
   * Executed strictly AFTER transaction COMMIT.
   * - Emits session:invalidated and disconnects obsolete device socket
   * - Removes participant from LiveKit SFU (eliminates zombie reconnects)
   * - Emits consultation:critical_resume to new device
   * - Notifies veterinarian if tutor is reconnecting
   */
  public async handlePostCommitEvictionAndResume(
    params: PostCommitEvictionParams
  ): Promise<void> {
    const { consultationId, tutorId, revokedDeviceId, newDeviceId, status, stateVersion, vetId } = params;

    // 1. Evict obsolete device
    if (revokedDeviceId && io) {
      const revokedCompoundIdentity = `tutor_${tutorId}:${revokedDeviceId}`;

      // a. Notify obsolete device
      io.to(`device:${revokedDeviceId}`).emit('session:invalidated', {
        reason: 'SESSION_MIGRATED_NEW_DEVICE',
        consultationId,
      });

      // b. Force disconnect obsolete sockets
      try {
        const oldSockets = await io.in(`device:${revokedDeviceId}`).fetchSockets();
        for (const s of oldSockets) {
          s.disconnect(true);
        }
      } catch (err) {
        logger.warn({ consultationId, revokedDeviceId, err: serializeError(err) }, '[Session Eviction] Error disconnecting revoked sockets');
      }

      // c. Remove participant from LiveKit SFU
      try {
        await callsService.removeParticipant(consultationId, revokedCompoundIdentity);
      } catch (err) {
        logger.warn({ consultationId, revokedCompoundIdentity, err: serializeError(err) }, '[LiveKit SFU] Error removing participant from LiveKit');
      }
    }

    // 2. Notify assigned veterinarian that tutor is reconnecting
    if (io && vetId) {
      io.to(`user:${vetId}`).emit('consultation:tutor_reconnecting', {
        consultationId,
        message: 'Tutor reconnecting from new device...',
      });
    }

    // 3. Emit critical resume to new device
    if (io && newDeviceId) {
      io.to(`device:${newDeviceId}`).emit('consultation:critical_resume', {
        consultationId,
        status,
        stateVersion,
        vetId,
      });
    }
  }
}

export const consultationConcurrencyService = new ConsultationConcurrencyService();
