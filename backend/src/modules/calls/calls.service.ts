import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { User, Role, ConsultationStatus, CallStatus, Prisma } from '@prisma/client';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { config } from '../../config/env';
import { AppError } from '../../middlewares/errorHandler';
import { io } from '../../realtime/socket.server';
import { notificationsService } from '../notifications/notifications.service';
import { logger, serializeError } from '../../lib/logger';
import { captureTelemetryException } from '../../lib/telemetry';
import { featureFlagsService } from '../admin/feature-flags.service';
import { extractDeviceId } from '../../contracts/consultation.contract';

const CALLABLE_CONSULTATION_STATUSES: ReadonlyArray<ConsultationStatus> = [
  ConsultationStatus.ACTIVE,
];

const getLiveKitConfig = () => {
  const apiKey = process.env.LIVEKIT_API_KEY || config.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET || config.LIVEKIT_API_SECRET;
  const rawUrl = (process.env.LIVEKIT_URL || process.env.LIVEKIT_HOST || config.LIVEKIT_URL).trim();

  // Format httpUrl for RoomServiceClient HTTP API
  const httpUrl = rawUrl.startsWith('http')
    ? rawUrl
    : rawUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

  // Format wsUrl for frontend LiveKitRoom WebSockets
  const wsUrl = rawUrl.startsWith('ws')
    ? rawUrl
    : rawUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

  return { apiKey, apiSecret, rawUrl, httpUrl, wsUrl };
};

function resolveWebhookEventDate(createdAt?: number | bigint): Date {
  if (typeof createdAt === 'bigint') {
    const num = Number(createdAt);
    if (Number.isFinite(num) && num > 0) {
      return new Date(num > 1e12 ? num : num * 1000);
    }
  } else if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) {
    return new Date(createdAt > 1e12 ? createdAt : createdAt * 1000);
  }
  return new Date();
}

function appendTelemetryEvent(
  existingMetadata: unknown,
  eventEntry: Record<string, unknown>,
  extraFields?: Record<string, unknown>
): Prisma.InputJsonValue {
  const base =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};
  const prevEvents = Array.isArray(base.events) ? (base.events as unknown[]) : [];
  const nextEvents = [...prevEvents.slice(-49), eventEntry];
  return {
    ...base,
    ...(extraFields ?? {}),
    events: nextEvents,
  } as Prisma.InputJsonValue;
}

export class CallsService {
  private getRoomService(): RoomServiceClient {
    const { httpUrl, apiKey, apiSecret } = getLiveKitConfig();
    return new RoomServiceClient(httpUrl, apiKey, apiSecret);
  }

  private async ensureCallInitiated(consultationId: string) {
    if (!prisma.call) return null;
    try {
      const existing = await prisma.call.findFirst({
        where: {
          consultationId,
          status: { in: [CallStatus.INITIATED, CallStatus.ACTIVE] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        return existing;
      }
      return await prisma.call.create({
        data: {
          consultationId,
          roomName: consultationId,
          status: CallStatus.INITIATED,
        },
      });
    } catch (err) {
      if (typeof isMissingTableError === 'function' && isMissingTableError(err)) {
        logger.warn({ consultationId }, '[LiveKit Token] Skipping Call telemetry row due to schema lag');
        return null;
      }
      throw err;
    }
  }

  public async deleteLiveKitRoom(roomName: string): Promise<void> {
    try {
      if (!roomName) return;
      const roomService = this.getRoomService();
      await roomService.deleteRoom(roomName);
    } catch (err) {
      // Gracefully handle room already closed or connection error
      logger.warn({ roomName, err: serializeError(err) }, '[LiveKit Teardown] Room teardown notice');
    }
  }

  public async removeParticipant(roomName: string, identity: string): Promise<void> {
    try {
      if (!roomName || !identity) return;
      const roomService = this.getRoomService();
      await roomService.removeParticipant(roomName, identity);
    } catch (err) {
      logger.warn(
        { roomName, identity, err: serializeError(err) },
        '[LiveKit SFU] Failed to remove participant from room'
      );
    }
  }

  public async handleWebhook(rawBody: string | Buffer, authHeader?: string) {
    const { apiKey, apiSecret } = getLiveKitConfig();
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    const bodyString = typeof rawBody === 'string' ? rawBody : rawBody ? rawBody.toString('utf-8') : '';

    let event;
    try {
      event = await receiver.receive(bodyString, authHeader);
    } catch (err) {
      logger.warn({ err: serializeError(err) }, '[LiveKit Webhook] Signature verification failed');
      throw new AppError('Firma de webhook LiveKit inválida', 401, 'INVALID_WEBHOOK_SIGNATURE');
    }

    const roomName = event.room?.name;
    const roomSid = event.room?.sid ?? null;
    const eventTime = resolveWebhookEventDate(event.createdAt);

    logger.info(
      {
        event: event.event,
        roomName,
        roomSid,
        participantSid: event.participant?.sid,
      },
      'LiveKit webhook received'
    );

    if (!roomName || !prisma.call) {
      return event;
    }

    let call = await prisma.call.findFirst({
      where: { roomName },
      orderBy: { createdAt: 'desc' },
    });

    if (!call && event.event === 'room_started' && prisma.consultation) {
      const consultation = await prisma.consultation.findFirst({
        where: { id: roomName, deletedAt: null },
        select: { id: true },
      });
      if (consultation) {
        call = await prisma.call.create({
          data: {
            consultationId: consultation.id,
            roomName,
            livekitRoomSid: roomSid,
            status: CallStatus.INITIATED,
          },
        });
      }
    }

    if (!call) {
      logger.info({ event: event.event, roomName }, '[LiveKit Webhook] Ignoring event for unknown call room');
      return event;
    }

    const eventRecord: Record<string, unknown> = {
      event: event.event,
      at: eventTime.toISOString(),
      ...(event.participant?.identity ? { participantIdentity: event.participant.identity } : {}),
      ...(event.participant?.sid ? { participantSid: event.participant.sid } : {}),
    };

    const eventName: string = event.event;
    switch (eventName) {
      case 'room_started': {
        if (call.status === CallStatus.ENDED) {
          return event;
        }
        await prisma.call.update({
          where: { id: call.id },
          data: {
            status: CallStatus.ACTIVE,
            startedAt: call.startedAt ?? eventTime,
            livekitRoomSid: roomSid ?? call.livekitRoomSid,
            lastEvent: 'room_started',
            metadata: appendTelemetryEvent(call.metadata, eventRecord),
          },
        });
        if (roomSid && prisma.consultation?.updateMany) {
          await prisma.consultation
            .updateMany({
              where: { id: call.consultationId },
              data: { livekitRoomSid: roomSid },
            })
            .catch(() => {});
        }
        break;
      }

      case 'participant_joined': {
        const joinedIdentity = event.participant?.identity;
        if (joinedIdentity && typeof prisma.consultation?.findUnique === 'function') {
          const cons = await prisma.consultation.findUnique({
            where: { id: roomName },
            select: { clientId: true, activeDeviceId: true },
          });
          if (cons?.activeDeviceId) {
            const tutorPrefix = `tutor_${cons.clientId}:`;
            const isLegacyIdentity = joinedIdentity === cons.clientId;
            const isMismatchedDevice =
              joinedIdentity.startsWith(tutorPrefix) &&
              joinedIdentity.slice(tutorPrefix.length) !== cons.activeDeviceId;

            if (isLegacyIdentity || isMismatchedDevice) {
              logger.info(
                {
                  consultationId: roomName,
                  identity: joinedIdentity,
                  activeDeviceId: cons.activeDeviceId,
                  outcome: 'reactive_sfu_eviction',
                },
                '[LiveKit Webhook] Evicting stale participant on participant_joined'
              );
              void this.removeParticipant(roomName, joinedIdentity);
              return event;
            }
          }
        }
        if (call.status === CallStatus.ENDED) {
          return event;
        }
        await prisma.call.update({
          where: { id: call.id },
          data: {
            participantCount: { increment: 1 },
            livekitRoomSid: roomSid ?? call.livekitRoomSid,
            lastEvent: 'participant_joined',
            metadata: appendTelemetryEvent(call.metadata, eventRecord),
          },
        });
        break;
      }

      case 'participant_left': {
        if (call.status === CallStatus.ENDED) {
          return event;
        }
        await prisma.call.update({
          where: { id: call.id },
          data: {
            participantCount: (call.participantCount ?? 0) > 0 ? { decrement: 1 } : 0,
            livekitRoomSid: roomSid ?? call.livekitRoomSid,
            lastEvent: 'participant_left',
            metadata: appendTelemetryEvent(call.metadata, eventRecord),
          },
        });
        break;
      }

      case 'participant_connection_aborted':
      case 'room_aborted':
      case 'track_publish_failed': {
        if (call.status === CallStatus.ENDED) {
          return event;
        }
        const isParticipantAbort = eventName === 'participant_connection_aborted';
        const isRoomAborted = eventName === 'room_aborted';
        const durationSeconds =
          isRoomAborted && call.startedAt
            ? Math.max(0, Math.round((eventTime.getTime() - new Date(call.startedAt).getTime()) / 1000))
            : undefined;
        await prisma.call.update({
          where: { id: call.id },
          data: {
            ...(!isParticipantAbort ? { status: CallStatus.FAILED } : {}),
            ...(isRoomAborted
              ? {
                  endedAt: eventTime,
                  participantCount: 0,
                  ...(durationSeconds !== undefined ? { durationSeconds } : {}),
                }
              : {}),
            errorCode: eventName.toUpperCase(),
            errorMessage: `LiveKit ${eventName}${
              event.participant?.identity ? ` (${event.participant.identity})` : ''
            }`,
            disconnectReason: isParticipantAbort ? 'PARTICIPANT_CONNECTION_ABORTED' : eventName.toUpperCase(),
            lastEvent: eventName,
            livekitRoomSid: roomSid ?? call.livekitRoomSid,
            ...(isParticipantAbort
              ? { participantCount: (call.participantCount ?? 0) > 0 ? { decrement: 1 } : 0 }
              : {}),
            metadata: appendTelemetryEvent(call.metadata, eventRecord, {
              lastFailure: eventRecord,
            }),
          },
        });
        io?.to([`consultation:${call.consultationId}`]).emit('call:degraded', {
          consultationId: call.consultationId,
          errorCode: eventName.toUpperCase(),
          at: eventTime.toISOString(),
        });
        break;
      }

      case 'room_finished': {
        if (call.status === CallStatus.ENDED) {
          logger.info({ callId: call.id, roomName }, '[LiveKit Webhook] Duplicate room_finished ignored');
          return event;
        }
        const endedAt = eventTime;
        const durationSeconds = call.startedAt
          ? Math.max(0, Math.round((endedAt.getTime() - new Date(call.startedAt).getTime()) / 1000))
          : 0;
        await prisma.call.update({
          where: { id: call.id },
          data: {
            status: CallStatus.ENDED,
            endedAt,
            durationSeconds,
            participantCount: 0,
            livekitRoomSid: roomSid ?? call.livekitRoomSid,
            lastEvent: 'room_finished',
            metadata: appendTelemetryEvent(call.metadata, eventRecord),
          },
        });
        await this.deleteLiveKitRoom(roomName);
        break;
      }

      default: {
        await prisma.call.update({
          where: { id: call.id },
          data: {
            lastEvent: event.event,
            metadata: appendTelemetryEvent(call.metadata, eventRecord),
          },
        });
        break;
      }
    }

    return event;
  }

  public async generateLiveKitToken(consultationId: string, user: User, requestDeviceId?: string) {
    await featureFlagsService.syncFromRedis();
    featureFlagsService.assertEnabled('VIDEOCALLS_ENABLED');

    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isClient = consultation.clientId === user.id;
    const isVet = consultation.vetId === user.id;
    const isAdmin = user.role === Role.ADMIN;

    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('Acceso denegado: no eres participante de esta consulta', 403, 'FORBIDDEN');
    }

    if (!CALLABLE_CONSULTATION_STATUSES.includes(consultation.status)) {
      throw new AppError('Solo se pueden generar tokens para consultas activas', 400, 'INVALID_CONSULTATION_STATE');
    }

    const { apiKey, apiSecret, wsUrl } = getLiveKitConfig();
    const normalizedRequestDeviceId = extractDeviceId(requestDeviceId);
    let effectiveDeviceId: string | null = consultation.activeDeviceId ?? null;

    if (isClient) {
      if (effectiveDeviceId !== null) {
        if (normalizedRequestDeviceId !== effectiveDeviceId) {
          throw new AppError(
            'Tu sesión activa fue transferida a otro dispositivo',
            409,
            'DEVICE_SESSION_STALE'
          );
        }
      } else if (normalizedRequestDeviceId) {
        if (typeof prisma.consultation.updateMany === 'function') {
          const bindCas = await prisma.consultation.updateMany({
            where: {
              id: consultationId,
              clientId: user.id,
              activeDeviceId: null,
              deletedAt: null,
            },
            data: {
              activeDeviceId: normalizedRequestDeviceId,
              stateVersion: { increment: 1 },
            },
          });

          if (bindCas.count === 0) {
            const latest = await prisma.consultation.findUnique({
              where: { id: consultationId },
              select: { activeDeviceId: true },
            });
            if (latest?.activeDeviceId !== normalizedRequestDeviceId) {
              throw new AppError(
                'Tu sesión activa fue transferida a otro dispositivo',
                409,
                'DEVICE_SESSION_STALE'
              );
            }
          }
        }
        effectiveDeviceId = normalizedRequestDeviceId;
      }
    }

    // Zero PII guardrail: compound identity for tutor with active device, else user.id (NO email or phone)
    const identity =
      isClient && effectiveDeviceId ? `tutor_${user.id}:${effectiveDeviceId}` : user.id;

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: user.firstName,
      ttl: '15m',
    });

    at.addGrant({
      roomJoin: true,
      room: consultationId,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    await this.ensureCallInitiated(consultationId);

    return {
      token,
      wsUrl,
      roomName: consultationId,
    };
  }

  public async ringCall(consultationId: string, callerUser: User) {
    await featureFlagsService.syncFromRedis();
    featureFlagsService.assertEnabled('VIDEOCALLS_ENABLED');

    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    if (!CALLABLE_CONSULTATION_STATUSES.includes(consultation.status)) {
      throw new AppError('La consulta debe estar ACTIVE para iniciar llamada', 400, 'INVALID_CONSULTATION_STATE');
    }

    const isClient = consultation.clientId === callerUser.id;
    const isVet = consultation.vetId === callerUser.id;

    if (!isClient && !isVet && callerUser.role !== Role.ADMIN) {
      throw new AppError('No eres participante de esta consulta', 403, 'NOT_CONSULTATION_PARTICIPANT');
    }

    // Determine target recipient ID
    const targetUserId = isClient ? consultation.vetId : consultation.clientId;

    if (!targetUserId) {
      throw new AppError('No hay destinatario asignado en la consulta', 400, 'NO_TARGET_USER');
    }

    await this.ensureCallInitiated(consultationId);

    // Emit Socket.io 'call:incoming' event to target user room (Zero PII)
    if (io) {
      io.to(`user:${targetUserId}`).emit('call:incoming', {
        consultationId,
        callerName: callerUser.firstName,
        roomName: consultationId,
      });
    }

    // Persist notification and dispatch push notification
    await notificationsService
      .createAndDispatch(
        targetUserId,
        'Videoconsulta entrante',
        `${callerUser.firstName} te está llamando para una videoconsulta`,
        'CALL_INCOMING',
        { consultationId }
      )
      .catch(() => {});

    return {
      consultationId,
      targetUserId,
      status: 'RINGING',
    };
  }

  public async reportIncident(
    consultationId: string,
    reporter: User,
    dto: { reason: string; errorCode?: string }
  ) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
    });

    if (!consultation || consultation.deletedAt) {
      throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
    }

    const isClient = consultation.clientId === reporter.id;
    const isVet = consultation.vetId === reporter.id;
    const isAdmin = reporter.role === Role.ADMIN;
    if (!isClient && !isVet && !isAdmin) {
      throw new AppError('No eres participante de esta consulta', 403, 'NOT_CONSULTATION_PARTICIPANT');
    }

    const incidentCode = (dto.errorCode || 'CALL_CONNECTION_DEGRADED').trim();

    if (prisma.consultationMetadata?.upsert) {
      await prisma.consultationMetadata
        .upsert({
          where: { consultationId },
          create: { consultationId, incidentCode },
          update: { incidentCode },
        })
        .catch((err) => {
          if (typeof isMissingTableError === 'function' && isMissingTableError(err)) return;
          throw err;
        });
    }

    if (prisma.consultationAuditLog?.create) {
      await prisma.consultationAuditLog.create({
        data: {
          consultationId,
          eventType: 'CALL_INCIDENT',
          previousState: consultation.status,
          newState: consultation.status,
          actorId: reporter.id,
          metadata: { incidentCode, reason: dto.reason },
        },
      });
    }

    io?.to([`consultation:${consultationId}`]).emit('call:degraded', {
      consultationId,
      errorCode: incidentCode,
      reason: dto.reason,
      reportedBy: reporter.id,
    });
    void captureTelemetryException(new Error(dto.reason), {
      consultationId,
      incidentCode,
      reporterId: reporter.id,
    });

    const recipientId = isClient ? consultation.vetId : consultation.clientId;
    if (recipientId) {
      await notificationsService
        .createAndDispatch(
          recipientId,
          'Inconveniente técnico en videollamada',
          `${reporter.firstName || 'El participante'} reportó un fallo técnico: ${dto.reason}. Podés continuar por chat o reprogramar.`,
          'CALL_INCIDENT',
          { consultationId, incidentCode }
        )
        .catch(() => {});
    }

    return {
      consultationId,
      incidentCode,
      reason: dto.reason,
    };
  }
}

export const callsService = new CallsService();
