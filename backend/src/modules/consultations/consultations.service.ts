import { ConsultationStatus, CallStatus, Role, VetStatus, User, Prisma } from '@prisma/client';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { callsService } from '../calls/calls.service';
import { notificationsService } from '../notifications/notifications.service';
import {
  CreateConsultationDTO,
  CompleteConsultationDTO,
  CancelConsultationDTO,
  RescheduleConsultationDTO,
  ReviewConsultationDTO,
  CreateMessageDTO,
} from './consultations.schemas';
import { evaluateClinicalTriage } from './clinicalTriage.engine';
import { io } from '../../realtime/socket.server';
import { presenceService } from '../../realtime/presence.service';
import { logger, serializeError } from '../../lib/logger';
import { featureFlagsService } from '../admin/feature-flags.service';
import { paymentsService } from '../payments/payments.service';
import {
  ClinicalConsultationStatus,
  ConsultationAuditEntry,
  POST_CALL_DISCONNECT_GRACE_MS,
  POST_CALL_MIN_DURATION_SEC,
  VET_DISCONNECT_GRACE_MS,
  extractDeviceId,
} from '../../contracts/consultation.contract';

const userSelectFields = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  vetStatus: true,
  licenseNumber: true,
  ratingAvg: true,
  ratingCount: true,
  photoUrl: true,
};

export interface HandoffTutorDeviceResult {
  hasActiveConsultation: boolean;
  didSwapDevice?: boolean;
  consultationId?: string;
  vetId?: string | null;
  revokedDeviceId?: string | null;
  status?: ClinicalConsultationStatus;
  stateVersion?: number;
}

export class ConsultationsService {
  private async recordConsultationAudit(
    tx: Prisma.TransactionClient,
    entry: ConsultationAuditEntry
  ): Promise<void> {
    if (!tx.consultationAuditLog?.create) {
      return;
    }
    await tx.consultationAuditLog.create({
      data: {
        consultationId: entry.consultationId,
        eventType: entry.eventType,
        previousState: entry.previousState,
        newState: entry.newState,
        actorId: entry.actorId,
        deviceId: entry.deviceId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  private async expireWaitingConsultation(
    consultation: {
      id: string;
      clientId: string;
      notes: string | null;
      status: ConsultationStatus;
      stateVersion?: number | null;
      activeDeviceId?: string | null;
    }
  ) {
    const endedAt = new Date();
    const updatedNotes = consultation.notes
      ? `${consultation.notes} [CANCELLED_TIMEOUT_NO_VET_AVAILABLE]`
      : '[CANCELLED_TIMEOUT_NO_VET_AVAILABLE]';
    const nextVersion = Number(consultation.stateVersion ?? 1) + 1;

    const updated = await prisma.$transaction(async (tx) => {
      const cas = await tx.consultation.updateMany({
        where: {
          id: consultation.id,
          status: ConsultationStatus.WAITING,
          deletedAt: null,
        },
        data: {
          status: ConsultationStatus.CANCELLED,
          endedAt,
          stateVersion: { increment: 1 },
          notes: updatedNotes,
        },
      });

      if (cas.count === 0) {
        return null;
      }

      await this.recordConsultationAudit(tx, {
        consultationId: consultation.id,
        eventType: 'TIMEOUT_TRIAGE',
        previousState: ConsultationStatus.WAITING,
        newState: ConsultationStatus.CANCELLED,
        actorId: null,
        deviceId: consultation.activeDeviceId ?? null,
        metadata: { stateVersion: nextVersion },
      });

      const persisted = await tx.consultation.findUnique({
        where: { id: consultation.id },
      });

      return (
        persisted ?? {
          ...consultation,
          status: ConsultationStatus.CANCELLED,
          endedAt,
          notes: updatedNotes,
          stateVersion: nextVersion,
        }
      );
    });

    if (!updated) {
      return prisma.consultation.findUnique({ where: { id: consultation.id } });
    }

    await callsService.deleteLiveKitRoom(consultation.id).catch(() => {});

    try {
      const rooms = [
        `consultation:${consultation.id}`,
        'role:vets',
        ...(updated.clientId ? [`user:${updated.clientId}`] : []),
      ];
      io?.to(rooms).emit('consultation:cancelled', {
        consultationId: consultation.id,
        cancelledBy: 'SYSTEM_TIMEOUT',
        status: updated.status,
      });
    } catch {
      // Non-blocking realtime notification
    }

    return updated;
  }

  public async createConsultation(clientId: string, dto: CreateConsultationDTO, deviceId?: string) {
    await featureFlagsService.syncFromRedis();
    featureFlagsService.assertEnabled('TRIAGE_ACTIVE');

    const pet = await prisma.pet.findFirst({
      where: { id: dto.petId, ownerId: clientId, deletedAt: null },
    });

    if (!pet) {
      throw new AppError('Mascota no encontrada o no pertenece al usuario', 404, 'PET_NOT_FOUND');
    }

    const triageResult = evaluateClinicalTriage({
      pet,
      notes: dto.notes,
      symptoms: dto.symptoms,
      duration: dto.duration,
    });

    const normalizedDeviceId = extractDeviceId(deviceId);
    const isTestEnv = process.env.NODE_ENV === 'test';
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const consultation = await prisma.$transaction(async (tx) => {
      if (typeof (tx as unknown as { $executeRaw?: unknown }).$executeRaw === 'function') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${clientId}))`;
      }

      const activeCons = await tx.consultation.findFirst({
        where: {
          clientId,
          status: { in: [ConsultationStatus.WAITING, ConsultationStatus.ACTIVE] },
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (activeCons) {
        const isExpiredWaiting =
          activeCons.status === ConsultationStatus.WAITING &&
          activeCons.createdAt < fifteenMinutesAgo;

        if (isExpiredWaiting) {
          await tx.consultation.updateMany({
            where: { id: activeCons.id, status: ConsultationStatus.WAITING, deletedAt: null },
            data: {
              status: ConsultationStatus.CANCELLED,
              endedAt: new Date(),
              stateVersion: { increment: 1 },
              notes: activeCons.notes
                ? `${activeCons.notes} [CANCELLED_TIMEOUT_NO_VET_AVAILABLE]`
                : '[CANCELLED_TIMEOUT_NO_VET_AVAILABLE]',
            },
          });
          await this.recordConsultationAudit(tx, {
            consultationId: activeCons.id,
            eventType: 'TIMEOUT_TRIAGE',
            previousState: ConsultationStatus.WAITING,
            newState: ConsultationStatus.CANCELLED,
            actorId: null,
            deviceId: activeCons.activeDeviceId ?? null,
            metadata: { stateVersion: Number(activeCons.stateVersion ?? 1) + 1 },
          });
        } else {
          throw new AppError(
            'Ya tenés una consulta activa o en sala de espera',
            409,
            'CONSULTATION_ALREADY_ACTIVE'
          );
        }
      }

      const availableVet = isTestEnv
        ? await tx.user.findFirst({
            where: {
              role: Role.VET,
              vetStatus: VetStatus.APPROVED,
              isOnline: true,
              deletedAt: null,
            },
            orderBy: { lastSeen: 'desc' },
          })
        : null;

      const status = availableVet ? ConsultationStatus.ACTIVE : ConsultationStatus.WAITING;
      const startedAt = availableVet ? new Date() : null;

      return tx.consultation.create({
        data: {
          clientId,
          vetId: availableVet ? availableVet.id : null,
          petId: dto.petId,
          notes: triageResult.formattedNotes,
          status,
          startedAt,
          ...(normalizedDeviceId ? { activeDeviceId: normalizedDeviceId } : {}),
        },
        include: {
          pet: true,
          client: { select: userSelectFields },
          vet: { select: userSelectFields },
        },
      });
    });

    // Notify connected vets in real-time via Socket.io
    try {
      const { io: activeIo } = await import('../../realtime/socket.server');
      if (activeIo) {
        // Redact PII (email, phone) in consultation.client while in WAITING status (ADR-009 / Ley 25.326)
        const sanitizedClient = consultation.client
          ? {
              ...consultation.client,
              email: undefined,
              phone: undefined,
            }
          : consultation.client;
        const sanitizedConsultation = {
          ...consultation,
          client: sanitizedClient,
        };
        activeIo.to('role:vets').emit('consultation:new', sanitizedConsultation as unknown as Record<string, unknown>);
      }
    } catch {
      // Broadcast error should never fail consultation creation
    }

    return consultation;
  }

  public async handoffTutorDevice(
    clientId: string,
    newDeviceId: string
  ): Promise<HandoffTutorDeviceResult> {
    const validDeviceId = extractDeviceId(newDeviceId);
    if (!validDeviceId) {
      return { hasActiveConsultation: false };
    }

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const record = await prisma.consultation.findFirst({
        where: {
          clientId,
          deletedAt: null,
          status: { in: [ConsultationStatus.WAITING, ConsultationStatus.ACTIVE] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          clientId: true,
          vetId: true,
          status: true,
          activeDeviceId: true,
          stateVersion: true,
        },
      });

      if (!record) {
        return { hasActiveConsultation: false };
      }

      const currentVersion = Number(record.stateVersion ?? 1);
      if (record.activeDeviceId === validDeviceId) {
        return {
          hasActiveConsultation: true,
          didSwapDevice: false,
          consultationId: record.id,
          vetId: record.vetId ?? null,
          revokedDeviceId: null,
          status: record.status as ClinicalConsultationStatus,
          stateVersion: currentVersion,
        };
      }

      const nextVersion = currentVersion + 1;
      const previousDeviceId = record.activeDeviceId ?? null;
      const didSwapDevice = Boolean(previousDeviceId && previousDeviceId !== validDeviceId);

      const committed = await prisma.$transaction(async (tx) => {
        const cas = await tx.consultation.updateMany({
          where: {
            id: record.id,
            clientId,
            status: record.status,
            stateVersion: currentVersion,
            deletedAt: null,
          },
          data: {
            activeDeviceId: validDeviceId,
            stateVersion: nextVersion,
          },
        });

        if (cas.count === 0) {
          return false;
        }

        await this.recordConsultationAudit(tx, {
          consultationId: record.id,
          eventType: 'DEVICE_HANDOFF',
          previousState: record.status,
          newState: record.status,
          actorId: clientId,
          deviceId: validDeviceId,
          metadata: {
            revokedDeviceId: previousDeviceId,
            stateVersion: nextVersion,
          },
        });

        return true;
      });

      if (committed) {
        logger.info(
          {
            consultationId: record.id,
            userId: clientId,
            deviceId: validDeviceId,
            revokedDeviceId: previousDeviceId ?? undefined,
            stateVersion: nextVersion,
            outcome: didSwapDevice ? 'device_handoff_swapped' : 'device_handoff_bound',
          },
          '[ConsultationsService] Committed tutor device handoff'
        );
        return {
          hasActiveConsultation: true,
          didSwapDevice,
          consultationId: record.id,
          vetId: record.vetId ?? null,
          revokedDeviceId: previousDeviceId,
          status: record.status as ClinicalConsultationStatus,
          stateVersion: nextVersion,
        };
      }
    }

    logger.warn(
      { userId: clientId, deviceId: validDeviceId, outcome: 'device_handoff_cas_exhausted' },
      '[ConsultationsService] Exhausted CAS retries during handoffTutorDevice'
    );
    return { hasActiveConsultation: false };
  }

  public async checkTriageTimeout(consultationId: string) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt || consultation.status !== ConsultationStatus.WAITING) {
      return consultation;
    }

    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (consultation.createdAt < fifteenMinutesAgo) {
      return this.expireWaitingConsultation(consultation);
    }

    return consultation;
  }

  public async checkVetDisconnectTimeout(consultationId: string, disconnectedAt: Date) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt || consultation.status !== ConsultationStatus.ACTIVE) {
      return consultation;
    }

    // In multi-instance production, verify distributed presence before timing out in case vet reconnected on another node
    if (consultation.vetId && presenceService.isDistributedActive()) {
      try {
        const presenceMap = await presenceService.getUsersPresence([consultation.vetId]);
        if (presenceMap.get(consultation.vetId)?.isOnline) {
          return consultation;
        }
      } catch {
        // Fallback safely if presence lookup fails
      }
    }

    // Bounded post-call clinical documentation grace: skip 3-minute timeout only if the
    // latest call ended cleanly (>= 10s duration) within the last 30 minutes.
    if (typeof prisma.call?.findFirst === 'function') {
      try {
        const latestCall = await prisma.call.findFirst({
          where: { consultationId },
          orderBy: { createdAt: 'desc' },
        });
        if (
          latestCall &&
          latestCall.status === CallStatus.ENDED &&
          (latestCall.durationSeconds ?? 0) >= POST_CALL_MIN_DURATION_SEC &&
          latestCall.endedAt &&
          Date.now() - new Date(latestCall.endedAt).getTime() < POST_CALL_DISCONNECT_GRACE_MS
        ) {
          logger.info(
            {
              consultationId,
              outcome: 'skipped_post_call_grace',
              livekitRoomSid: latestCall.livekitRoomSid ?? undefined,
            },
            '[ConsultationsService] Skipping 3m vet disconnect timeout within post-call grace window'
          );
          return consultation;
        }
      } catch {
        // Continue normal evaluation if call lookup fails
      }
    }

    const threeMinutesAgo = new Date(Date.now() - VET_DISCONNECT_GRACE_MS);
    if (disconnectedAt < threeMinutesAgo) {
      const endedAt = new Date();
      const updatedNotes = consultation.notes
        ? `${consultation.notes} [VET_DISCONNECTED_TIMEOUT]`
        : '[VET_DISCONNECTED_TIMEOUT]';
      const nextVersion = Number(consultation.stateVersion ?? 1) + 1;

      const updated = await prisma.$transaction(async (tx) => {
        const cas = await tx.consultation.updateMany({
          where: {
            id: consultationId,
            status: ConsultationStatus.ACTIVE,
            deletedAt: null,
          },
          data: {
            status: ConsultationStatus.CANCELLED,
            endedAt,
            stateVersion: { increment: 1 },
            notes: updatedNotes,
          },
        });

        if (cas.count === 0) {
          return null;
        }

        await this.recordConsultationAudit(tx, {
          consultationId,
          eventType: 'TIMEOUT_VET_DISCONNECT',
          previousState: ConsultationStatus.ACTIVE,
          newState: ConsultationStatus.CANCELLED,
          actorId: null,
          deviceId: consultation.activeDeviceId ?? null,
          metadata: {
            vetId: consultation.vetId ?? null,
            disconnectedAt: disconnectedAt.toISOString(),
            stateVersion: nextVersion,
          },
        });

        const persisted = await tx.consultation.findUnique({ where: { id: consultationId } });
        return (
          persisted ?? {
            ...consultation,
            status: ConsultationStatus.CANCELLED,
            endedAt,
            notes: updatedNotes,
            stateVersion: nextVersion,
          }
        );
      });

      if (!updated) {
        return prisma.consultation.findUnique({ where: { id: consultationId } });
      }

      await callsService.deleteLiveKitRoom(consultationId).catch(() => {});

      try {
        const rooms = [
          `consultation:${consultationId}`,
          'role:vets',
          ...(updated.clientId ? [`user:${updated.clientId}`] : []),
        ];
        io?.to(rooms).emit('consultation:cancelled', {
          consultationId,
          cancelledBy: 'SYSTEM_VET_DISCONNECT_TIMEOUT',
          status: updated.status,
        });
      } catch {
        // Non-blocking realtime notification
      }

      logger.info(
        {
          consultationId,
          vetId: consultation.vetId ?? undefined,
          stateVersion: nextVersion,
          outcome: 'vet_disconnect_timeout_cancelled',
        },
        '[ConsultationsService] Cancelled ACTIVE consultation after vet disconnect grace window'
      );

      return updated;
    }

    return consultation;
  }

  public async assignConsultation(consultationId: string, vetUser: User) {
    if (vetUser.role !== Role.VET) {
      throw new AppError('Solo veterinarios pueden atender consultas', 403, 'VET_REQUIRED');
    }

    if (vetUser.vetStatus !== VetStatus.APPROVED) {
      if (process.env.NODE_ENV === 'development' && process.env.AUTO_APPROVE_VETS === 'true') {
        await prisma.user.update({
          where: { id: vetUser.id },
          data: { vetStatus: VetStatus.APPROVED },
        });
      } else {
        throw new AppError('Solo veterinarios aprobados pueden atender consultas', 403, 'VET_NOT_APPROVED');
      }
    }

    await this.checkTriageTimeout(consultationId);

    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    if (consultation.status !== ConsultationStatus.WAITING) {
      throw new AppError('La consulta ya ha sido asignada o no se encuentra en espera', 409, 'CONSULTATION_ALREADY_ASSIGNED');
    }

    const hasVersion = typeof consultation.stateVersion === 'number';
    const nextVersion = Number(consultation.stateVersion ?? 1) + 1;

    const assigned = await prisma.$transaction(async (tx) => {
      const casResult = await tx.consultation.updateMany({
        where: {
          id: consultationId,
          status: ConsultationStatus.WAITING,
          vetId: null,
          deletedAt: null,
          ...(hasVersion ? { stateVersion: consultation.stateVersion } : {}),
        },
        data: {
          vetId: vetUser.id,
          status: ConsultationStatus.ACTIVE,
          startedAt: new Date(),
          claimedAt: new Date(),
          ...(hasVersion ? { stateVersion: consultation.stateVersion + 1 } : {}),
        },
      });

      if (casResult.count === 0) {
        return false;
      }

      await this.recordConsultationAudit(tx, {
        consultationId,
        eventType: 'VET_ASSIGNED',
        previousState: ConsultationStatus.WAITING,
        newState: ConsultationStatus.ACTIVE,
        actorId: vetUser.id,
        deviceId: consultation.activeDeviceId ?? null,
        metadata: { stateVersion: nextVersion },
      });

      return true;
    });

    if (!assigned) {
      throw new AppError(
        'La consulta ya ha sido asignada o no se encuentra en espera',
        409,
        'CONSULTATION_ALREADY_ASSIGNED'
      );
    }

    const updated = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        pet: true,
        client: { select: userSelectFields },
        vet: { select: userSelectFields },
      },
    });

    if (!updated) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    await notificationsService
      .createAndDispatch(
        updated.clientId,
        'Veterinario asignado',
        `El Dr. ${vetUser.firstName} ha tomado tu consulta y está listo para atenderte`,
        'CONSULTATION_ASSIGNED',
        { consultationId: updated.id }
      )
      .catch(() => {});

    try {
      const rooms = [
        `consultation:${consultationId}`,
        'role:vets',
        ...(updated.clientId ? [`user:${updated.clientId}`] : []),
      ];
      io?.to(rooms).emit('consultation:assigned', {
        consultationId: updated.id,
        vetId: updated.vetId,
        clientId: updated.clientId,
        status: updated.status,
      });
      logger.info(
        { consultationId: updated.id, vetId: updated.vetId, clientId: updated.clientId },
        'Consultation assigned'
      );
    } catch {
      // Non-blocking realtime notification
    }

    return updated;
  }

  public async completeConsultation(
    consultationId: string,
    requester: User,
    dto: CompleteConsultationDTO & { status?: string }
  ) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isVet && !isAdmin) {
      throw new AppError(
        'Solo el veterinario asignado puede finalizar la consulta con diagnóstico clínico',
        403,
        'FORBIDDEN'
      );
    }

    if (consultation.status !== ConsultationStatus.ACTIVE) {
      throw new AppError('Solo se pueden finalizar consultas en estado ACTIVE', 400, 'INVALID_STATUS');
    }

    const endedAt = new Date();
    const diagnosisNotes = dto.diagnosisNotes || 'Consulta telemática finalizada con éxito.';
    const nextVersion = Number(consultation.stateVersion ?? 1) + 1;

    const completed = await prisma.$transaction(async (tx) => {
      const cas = await tx.consultation.updateMany({
        where: {
          id: consultationId,
          status: ConsultationStatus.ACTIVE,
          deletedAt: null,
        },
        data: {
          status: ConsultationStatus.COMPLETED,
          endedAt,
          stateVersion: { increment: 1 },
          diagnosisNotes,
        },
      });

      if (cas.count === 0) {
        throw new AppError(
          'La consulta ya fue finalizada o modificada concurrentemente',
          409,
          'CONSULTATION_STATE_CONFLICT'
        );
      }

      await this.recordConsultationAudit(tx, {
        consultationId,
        eventType: 'COMPLETED',
        previousState: ConsultationStatus.ACTIVE,
        newState: ConsultationStatus.COMPLETED,
        actorId: requester.id,
        deviceId: consultation.activeDeviceId ?? null,
        metadata: { stateVersion: nextVersion },
      });

      const persisted = await tx.consultation.findUnique({
        where: { id: consultationId },
        include: {
          pet: true,
          client: { select: userSelectFields },
          vet: { select: userSelectFields },
        },
      });

      return (
        persisted ?? {
          ...consultation,
          status: ConsultationStatus.COMPLETED,
          endedAt,
          diagnosisNotes,
          stateVersion: nextVersion,
        }
      );
    });

    // Tear down LiveKit cloud room to release bandwidth
    await callsService.deleteLiveKitRoom(consultationId).catch(() => {});

    // Record simulated PagoFlex-ready ledger entry (non-blocking)
    await paymentsService
      .recordSimulatedCompletionEntry(consultationId, completed.vetId ?? consultation.vetId)
      .catch(() => {});

    // Broadcast call:ended event via Socket.io to consultation & participant rooms
    try {
      const clientId = completed.clientId ?? consultation.clientId;
      const vetId = completed.vetId ?? consultation.vetId;
      const rooms = Array.from(
        new Set([
          `consultation:${consultationId}`,
          ...(clientId ? [`user:${clientId}`] : []),
          ...(vetId ? [`user:${vetId}`] : []),
        ])
      );
      io?.to(rooms).emit('call:ended', {
        consultationId,
        endedBy: requester.id,
      });
    } catch (err) {
      logger.warn({ consultationId, err: serializeError(err) }, 'Could not broadcast call:ended');
    }

    return completed;
  }

  public async cancelConsultation(consultationId: string, requester: User, dto?: CancelConsultationDTO) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isClient = consultation.clientId === requester.id;
    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    if (
      consultation.status === ConsultationStatus.COMPLETED ||
      consultation.status === ConsultationStatus.CANCELLED
    ) {
      throw new AppError('La consulta ya ha finalizado', 400, 'CONSULTATION_ALREADY_ENDED');
    }

    const reasonText = dto?.reason ? ` [Razón: ${dto.reason}]` : '';
    const updatedNotes = consultation.notes ? `${consultation.notes}${reasonText}` : reasonText;
    const endedAt = new Date();
    const nextVersion = Number(consultation.stateVersion ?? 1) + 1;

    const cancelled = await prisma.$transaction(async (tx) => {
      const cas = await tx.consultation.updateMany({
        where: {
          id: consultationId,
          status: consultation.status,
          deletedAt: null,
        },
        data: {
          status: ConsultationStatus.CANCELLED,
          endedAt,
          stateVersion: { increment: 1 },
          notes: updatedNotes,
        },
      });

      if (cas.count === 0) {
        throw new AppError(
          'La consulta ya ha finalizado o fue modificada concurrentemente',
          409,
          'CONSULTATION_STATE_CONFLICT'
        );
      }

      await this.recordConsultationAudit(tx, {
        consultationId,
        eventType: 'CANCELLED',
        previousState: consultation.status,
        newState: ConsultationStatus.CANCELLED,
        actorId: requester.id,
        deviceId: consultation.activeDeviceId ?? null,
        metadata: { reason: dto?.reason ?? null, stateVersion: nextVersion },
      });

      const persisted = await tx.consultation.findUnique({
        where: { id: consultationId },
      });

      return (
        persisted ?? {
          ...consultation,
          status: ConsultationStatus.CANCELLED,
          endedAt,
          notes: updatedNotes,
          stateVersion: nextVersion,
        }
      );
    });

    // Tear down LiveKit room
    await callsService.deleteLiveKitRoom(consultationId).catch(() => {});

    try {
      const clientId = cancelled.clientId ?? consultation.clientId;
      const rooms = [
        `consultation:${consultationId}`,
        'role:vets',
        ...(clientId ? [`user:${clientId}`] : []),
      ];
      io?.to(rooms).emit('consultation:cancelled', {
        consultationId,
        cancelledBy: requester.id,
        status: cancelled.status ?? ConsultationStatus.CANCELLED,
      });
    } catch {
      // Non-blocking realtime notification
    }

    return cancelled;
  }

  public async rescheduleConsultation(
    consultationId: string,
    requester: User,
    dto: RescheduleConsultationDTO
  ) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    if (
      consultation.status === ConsultationStatus.COMPLETED ||
      consultation.status === ConsultationStatus.CANCELLED
    ) {
      throw new AppError('No se puede reprogramar una consulta finalizada o cancelada', 400, 'INVALID_STATUS');
    }

    const isClient = consultation.clientId === requester.id;
    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;
    let isCoOwner = false;
    if (!isClient && !isVet && !isAdmin && prisma.petCoOwner?.findFirst) {
      try {
        const co = await prisma.petCoOwner.findFirst({
          where: { petId: consultation.petId, userId: requester.id },
        });
        isCoOwner = Boolean(co);
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    if (!isClient && !isVet && !isAdmin && !isCoOwner) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    const nextScheduledAt = new Date(dto.scheduledAt);
    if (!Number.isFinite(nextScheduledAt.getTime()) || nextScheduledAt.getTime() <= Date.now() - 60_000) {
      throw new AppError('La nueva fecha debe ser futura', 400, 'INVALID_SCHEDULED_AT');
    }

    const targetVetId = dto.vetId || consultation.vetId;
    if (targetVetId && prisma.consultationMetadata?.findFirst) {
      const windowStart = new Date(nextScheduledAt.getTime() - 15 * 60 * 1000);
      const windowEnd = new Date(nextScheduledAt.getTime() + 15 * 60 * 1000);
      try {
        const conflict = await prisma.consultationMetadata.findFirst({
          where: {
            consultationId: { not: consultationId },
            scheduledAt: { gte: windowStart, lte: windowEnd },
            consultation: {
              vetId: targetVetId,
              deletedAt: null,
              status: { in: [ConsultationStatus.WAITING, ConsultationStatus.ACTIVE] },
            },
          },
        });
        if (conflict) {
          throw new AppError('El veterinario ya tiene un turno en ese horario', 409, 'SLOT_CONFLICT');
        }
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.consultation.update({
        where: { id: consultationId },
        data: {
          vetId: targetVetId ?? undefined,
          stateVersion: { increment: 1 },
        },
      });

      if (tx.consultationMetadata?.upsert) {
        await tx.consultationMetadata.upsert({
          where: { consultationId },
          create: {
            consultationId,
            scheduledAt: nextScheduledAt,
          },
          update: {
            scheduledAt: nextScheduledAt,
          },
        });
      }

      await this.recordConsultationAudit(tx, {
        consultationId,
        eventType: 'CONSULTATION_RESCHEDULED',
        previousState: consultation.status,
        newState: saved.status,
        actorId: requester.id,
        metadata: {
          scheduledAt: nextScheduledAt.toISOString(),
          reason: dto.reason || null,
        },
      });

      return saved;
    });

    const recipientId =
      requester.id === consultation.clientId ? targetVetId : consultation.clientId;
    if (recipientId) {
      await notificationsService
        .createAndDispatch(
          recipientId,
          'Turno reprogramado',
          `La consulta fue reprogramada para ${nextScheduledAt.toLocaleDateString('es-AR')} a las ${nextScheduledAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.`,
          'CONSULTATION_RESCHEDULED',
          { consultationId, scheduledAt: nextScheduledAt.toISOString() }
        )
        .catch(() => {});
    }

    return {
      ...updated,
      scheduledAt: nextScheduledAt.toISOString(),
    };
  }

  public async getConsultationById(consultationId: string, requester: User) {
    await this.checkTriageTimeout(consultationId);

    const consultation = await prisma.consultation.findFirst({
      where: { id: consultationId, deletedAt: null },
      include: {
        pet: true,
        client: { select: userSelectFields },
        vet: { select: userSelectFields },
        prescriptions: true,
        review: true,
      },
    });

    if (!consultation) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isClient = consultation.clientId === requester.id;
    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    return consultation;
  }

  public async getMine(requester: User) {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const consultations =
      requester.role === Role.VET
        ? await prisma.consultation.findMany({
            where: {
              OR: [{ vetId: requester.id }, { status: ConsultationStatus.WAITING }],
              deletedAt: null,
            },
            include: {
              pet: true,
              client: { select: userSelectFields },
              review: true,
              prescriptions: {
                select: { id: true, medication: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
              },
            },
            orderBy: { createdAt: 'desc' },
          })
        : await prisma.consultation.findMany({
            where: { clientId: requester.id, deletedAt: null },
            include: {
              pet: true,
              vet: { select: userSelectFields },
              review: true,
              prescriptions: {
                select: { id: true, medication: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
              },
            },
            orderBy: { createdAt: 'desc' },
          });

    // Bounded per-row triage expiry with transactional CAS + TIMEOUT_TRIAGE audit log
    const normalized = await Promise.all(
      consultations.map(async (c) => {
        if (
          c.status === ConsultationStatus.WAITING &&
          c.createdAt &&
          new Date(c.createdAt) < fifteenMinutesAgo
        ) {
          try {
            const expired = await this.expireWaitingConsultation({
              id: c.id,
              clientId: c.clientId,
              notes: c.notes ?? null,
              status: c.status,
              stateVersion: c.stateVersion,
              activeDeviceId: c.activeDeviceId,
            });
            if (expired) {
              return { ...c, status: expired.status, endedAt: expired.endedAt, notes: expired.notes };
            }
          } catch (err) {
            logger.warn(
              { consultationId: c.id, err: serializeError(err) },
              '[ConsultationsService.getMine] Error expiring timed out triage consultation'
            );
          }
        }
        return c;
      })
    );

    let withSchedule = normalized;
    if (normalized.length > 0 && prisma.consultationMetadata?.findMany) {
      let metas: Array<{ consultationId: string; scheduledAt: Date | null; incidentCode: string | null }> = [];
      try {
        metas = await prisma.consultationMetadata.findMany({
          where: { consultationId: { in: normalized.map((c) => c.id) } },
          select: { consultationId: true, scheduledAt: true, incidentCode: true },
        });
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
      const metaMap = new Map(metas.map((m) => [m.consultationId, m]));
      withSchedule = normalized.map((c) => {
        const meta = metaMap.get(c.id);
        return meta
          ? {
              ...c,
              scheduledAt: meta.scheduledAt ? meta.scheduledAt.toISOString() : null,
              incidentCode: meta.incidentCode ?? null,
            }
          : c;
      });
    }

    if (requester.role === Role.VET) {
      return withSchedule
        .filter((c) => c.vetId === requester.id || c.status === ConsultationStatus.WAITING)
        .map((c) => {
          if (c.status === ConsultationStatus.WAITING && 'client' in c && c.client) {
            const clientObj = c.client as Record<string, unknown>;
            const { email: _e, phone: _p, ...restClient } = clientObj;
            return {
              ...c,
              client: {
                ...restClient,
                email: undefined,
                phone: undefined,
              },
            };
          }
          return c;
        });
    }

    return withSchedule;
  }

  public async createReview(consultationId: string, clientUser: User, dto: ReviewConsultationDTO) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { review: true },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    if (consultation.clientId !== clientUser.id) {
      throw new AppError('Solo el tutor asignado puede calificar la consulta', 403, 'FORBIDDEN');
    }

    if (consultation.status !== ConsultationStatus.COMPLETED) {
      throw new AppError('Solo se pueden calificar consultas completadas', 400, 'CONSULTATION_NOT_COMPLETED');
    }

    if (!consultation.vetId) {
      throw new AppError('La consulta no posee un veterinario asignado', 400, 'NO_VET_ASSIGNED');
    }

    if (consultation.review) {
      throw new AppError('La consulta ya ha sido calificada anteriormente', 409, 'REVIEW_ALREADY_EXISTS');
    }

    // Atomic transaction (ADR-019 & ADR-023)
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const review = await tx.review.create({
        data: {
          consultationId,
          clientId: clientUser.id,
          vetId: consultation.vetId!,
          rating: dto.rating,
          comment: dto.comment || null,
        },
      });

      // Recalculate VET ratingAvg and ratingCount
      const allVetReviews = await tx.review.findMany({
        where: { vetId: consultation.vetId! },
        select: { rating: true },
      });

      const ratingCount = allVetReviews.length;
      const totalStars = allVetReviews.reduce((sum, r) => sum + r.rating, 0);
      const ratingAvg = ratingCount > 0 ? parseFloat((totalStars / ratingCount).toFixed(2)) : 0;

      await tx.user.update({
        where: { id: consultation.vetId! },
        data: {
          ratingAvg,
          ratingCount,
        },
      });

      return review;
    });
  }

  public async getMessages(consultationId: string, requester: User, afterIsoString?: string) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isClient = consultation.clientId === requester.id;
    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    const whereFilter: Prisma.MessageWhereInput = {
      consultationId,
      deletedAt: null,
    };

    if (afterIsoString) {
      whereFilter.createdAt = {
        gt: new Date(afterIsoString),
      };
    }

    return prisma.message.findMany({
      where: whereFilter,
      orderBy: { createdAt: 'asc' },
      include: {
        sender: {
          select: { id: true, firstName: true, lastName: true, role: true },
        },
      },
    });
  }

  public async createMessage(
    consultationId: string,
    requester: User,
    dto: CreateMessageDTO
  ) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    if (consultation.status === ConsultationStatus.CANCELLED) {
      throw new AppError(
        'No se pueden enviar mensajes a una consulta cancelada',
        400,
        'INVALID_CONSULTATION_STATE'
      );
    }

    const isClient = consultation.clientId === requester.id;
    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    try {
      const message = await prisma.message.create({
        data: {
          consultationId,
          senderId: requester.id,
          content: dto.content,
          clientMsgId: dto.clientMsgId,
          attachmentUrl: dto.attachmentUrl || null,
        },
        include: {
          sender: {
            select: { id: true, firstName: true, lastName: true, role: true },
          },
        },
      });

      try {
        io?.to(`consultation:${consultationId}`).emit('message:new', message as unknown as Record<string, unknown>);
      } catch (err) {
        logger.warn({ consultationId, err: serializeError(err) }, 'Could not broadcast message via socket');
      }

      return message;
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.message.findUnique({
          where: { clientMsgId: dto.clientMsgId },
          include: {
            sender: {
              select: { id: true, firstName: true, lastName: true, role: true },
            },
          },
        });
        return existing;
      }
      throw err;
    }
  }

  public async deleteConsultationMessages(consultationId: string, requester: User) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isClient = consultation.clientId === requester.id;
    const isVet = consultation.vetId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    const existingMessages = await prisma.message.findMany({
      where: { consultationId, deletedAt: null },
      select: { id: true, attachmentUrl: true },
    });

    const mediaUuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const referencedMediaIds = Array.from(
      new Set(
        existingMessages
          .map((m) => (m.attachmentUrl ? mediaUuidRe.exec(m.attachmentUrl)?.[0] : null))
          .filter((id): id is string => Boolean(id))
      )
    );

    const now = new Date();
    let localPathsToDelete: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      const deletedMsgs = await tx.message.updateMany({
        where: { consultationId, deletedAt: null },
        data: { deletedAt: now },
      });

      let deletedMediaCount = 0;
      if (typeof tx.mediaFile?.findMany === 'function') {
        const mediaRows = await tx.mediaFile.findMany({
          where: {
            deletedAt: null,
            OR: [
              { consultationId },
              ...(referencedMediaIds.length > 0 ? [{ id: { in: referencedMediaIds } }] : []),
            ],
            petDocuments: { none: {} },
            petPhotos: { none: {} },
          },
          select: { id: true, localPath: true },
        });

        if (mediaRows.length > 0) {
          localPathsToDelete = mediaRows
            .map((r) => r.localPath)
            .filter((p): p is string => Boolean(p));

          const deletedMedia = await tx.mediaFile.updateMany({
            where: { id: { in: mediaRows.map((r) => r.id) }, deletedAt: null },
            data: { deletedAt: now },
          });
          deletedMediaCount = deletedMedia.count;
        }
      }

      await this.recordConsultationAudit(tx, {
        consultationId,
        eventType: 'CHAT_DELETED',
        previousState: consultation.status,
        newState: consultation.status,
        actorId: requester.id,
        deviceId: consultation.activeDeviceId ?? null,
        metadata: {
          deletedMessages: deletedMsgs.count,
          deletedMedia: deletedMediaCount,
        },
      });

      return {
        consultationId,
        deletedMessages: deletedMsgs.count,
        deletedMedia: deletedMediaCount,
      };
    });

    if (localPathsToDelete.length > 0) {
      const fs = await import('fs');
      for (const filePath of localPathsToDelete) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Best-effort physical cleanup after DB commit
        }
      }
    }

    try {
      io?.to(`consultation:${consultationId}`).emit('chat:deleted', {
        consultationId,
        deletedBy: requester.id,
      });
    } catch {
      // Non-blocking realtime notification
    }

    return result;
  }
}

export const consultationsService = new ConsultationsService();
