import { ConsultationStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger, serializeError } from '../lib/logger';
import { SessionTerminationReason } from '../contracts/consultation.contract';
import { callsService } from '../modules/calls/calls.service';
import { io } from './socket.server';

export interface EvictUserRealtimeAndCallParams {
  userId: string;
  role?: string;
  reason: SessionTerminationReason;
  message: string;
  consultationId?: string | null;
  revokedDeviceId?: string | null;
  excludeDeviceId?: string;
  emitEvent?: boolean;
}

interface ActiveConsultationCandidate {
  id: string;
  clientId: string;
  vetId: string | null;
  activeDeviceId?: string | null;
}

const SOCKET_FLUSH_DISCONNECT_MS = 50;

function scheduleRoomDisconnect(disconnectFn: () => void): void {
  const timer = setTimeout(() => {
    try {
      disconnectFn();
    } catch {
      // Non-blocking socket cleanup
    }
  }, SOCKET_FLUSH_DISCONNECT_MS);
  timer.unref?.();
}

/**
 * Coordinates Socket.IO termination and best-effort LiveKit SFU participant
 * removal whenever a session is handed off to a new device or revoked via
 * login, logout, admin ban/suspension, or password reset.
 */
export async function evictUserRealtimeAndCall(
  params: EvictUserRealtimeAndCallParams
): Promise<void> {
  const {
    userId,
    role,
    reason,
    message,
    consultationId,
    revokedDeviceId,
    excludeDeviceId,
    emitEvent = true,
  } = params;

  if (emitEvent && io) {
    try {
      const payload = {
        reason,
        message,
        ...(consultationId ? { consultationId } : {}),
      };

      if (revokedDeviceId) {
        const deviceRoom = `device:${revokedDeviceId}`;
        io.to(deviceRoom).emit('auth:session_terminated', payload);
        scheduleRoomDisconnect(() => {
          void (async () => {
            try {
              const inRoom = io?.in?.(deviceRoom);
              if (inRoom && typeof inRoom.fetchSockets === 'function') {
                const sockets = await inRoom.fetchSockets();
                for (const sock of sockets) {
                  if (!sock.data?.user?.id || sock.data.user.id === userId) {
                    sock.disconnect(true);
                  }
                }
                return;
              }
              inRoom?.disconnectSockets?.(true);
            } catch {
              // Non-blocking disconnect
            }
          })();
        });
      } else if (excludeDeviceId) {
        io.to(`user:${userId}`)
          .except(`device:${excludeDeviceId}`)
          .emit('auth:session_terminated', payload);
        scheduleRoomDisconnect(() => {
          io?.in?.(`user:${userId}`)?.except?.(`device:${excludeDeviceId}`)?.disconnectSockets?.(true);
        });
      } else {
        io.to(`user:${userId}`).emit('auth:session_terminated', payload);
        scheduleRoomDisconnect(() => {
          io?.in?.(`user:${userId}`)?.disconnectSockets?.(true);
        });
      }
    } catch (err) {
      logger.warn(
        { userId, consultationId, revokedDeviceId, reason, outcome: 'socket_eviction_error', err: serializeError(err) },
        '[SessionEviction] Failed terminating sockets cleanly'
      );
    }
  }

  let targets: ActiveConsultationCandidate[] = [];
  if (consultationId) {
    targets = [
      {
        id: consultationId,
        clientId: userId,
        vetId: null,
        activeDeviceId: revokedDeviceId ?? null,
      },
    ];
  } else if (typeof prisma.consultation?.findMany === 'function') {
    try {
      const rows = await prisma.consultation.findMany({
        where: {
          status: ConsultationStatus.ACTIVE,
          deletedAt: null,
          OR: [{ clientId: userId }, { vetId: userId }],
        },
        select: {
          id: true,
          clientId: true,
          vetId: true,
          activeDeviceId: true,
        },
      });
      if (Array.isArray(rows)) {
        targets = rows;
      }
    } catch (err) {
      logger.warn(
        { userId, reason, outcome: 'lookup_active_consultation_failed', err: serializeError(err) },
        '[SessionEviction] Failed querying active consultations for SFU eviction'
      );
    }
  }

  for (const target of targets) {
    const isTutorTarget = target.clientId === userId || Boolean(revokedDeviceId);
    const identities = new Set<string>();

    if (revokedDeviceId) {
      identities.add(`tutor_${userId}:${revokedDeviceId}`);
    } else if (isTutorTarget) {
      if (target.activeDeviceId && target.activeDeviceId !== excludeDeviceId) {
        identities.add(`tutor_${userId}:${target.activeDeviceId}`);
      }
      identities.add(userId);
    } else if (role === 'VET' || target.vetId === userId) {
      identities.add(userId);
    }

    for (const identity of identities) {
      try {
        await callsService.removeParticipant(target.id, identity);
        logger.info(
          {
            userId,
            consultationId: target.id,
            revokedDeviceId: revokedDeviceId ?? target.activeDeviceId ?? undefined,
            identity,
            reason,
            outcome: 'sfu_eviction_dispatched',
          },
          '[SessionEviction] Dispatched LiveKit participant removal'
        );
      } catch (err) {
        logger.warn(
          {
            userId,
            consultationId: target.id,
            identity,
            reason,
            outcome: 'sfu_eviction_failed',
            err: serializeError(err),
          },
          '[SessionEviction] Failed LiveKit participant removal'
        );
      }
    }
  }
}
