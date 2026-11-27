import { ConsultationStatus, FollowUpStatus, Role, User, VetStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { notificationsService } from '../notifications/notifications.service';
import type {
  CreateAppointmentDTO,
  CreateFollowUpDTO,
  UpdateFollowUpDTO,
  UpsertAvailabilityDTO,
} from './scheduling.schemas';

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export class SchedulingService {
  public async getMyAvailability(requester: User) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden gestionar disponibilidad', 403, 'FORBIDDEN');
    }
    return prisma.vetAvailabilitySlot.findMany({
      where: { vetId: requester.id },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  public async upsertMyAvailability(requester: User, dto: UpsertAvailabilityDTO) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden gestionar disponibilidad', 403, 'FORBIDDEN');
    }

    const created = await prisma.$transaction(async (tx) => {
      await tx.vetAvailabilitySlot.deleteMany({
        where: { vetId: requester.id },
      });

      if (dto.slots.length === 0) {
        return [];
      }

      await tx.vetAvailabilitySlot.createMany({
        data: dto.slots.map((slot) => ({
          vetId: requester.id,
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          slotDurationMin: slot.slotDurationMin ?? 30,
          isActive: slot.isActive ?? true,
        })),
      });

      return tx.vetAvailabilitySlot.findMany({
        where: { vetId: requester.id },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      });
    });

    return created;
  }

  public async listVetsWithAvailability() {
    const vets = await prisma.user.findMany({
      where: {
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        licenseNumber: true,
        bio: true,
        photoUrl: true,
        isOnline: true,
        ratingAvg: true,
        ratingCount: true,
        availabilitySlots: {
          where: { isActive: true },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
      orderBy: [{ isOnline: 'desc' }, { ratingAvg: 'desc' }],
    });

    return vets.map((v) => ({
      id: v.id,
      firstName: v.firstName,
      lastName: v.lastName,
      specialty: null as string | null,
      licenseNumber: v.licenseNumber,
      bio: v.bio,
      photoUrl: v.photoUrl,
      isOnline: v.isOnline,
      rating: v.ratingAvg,
      slots: v.availabilitySlots.map((s) => ({
        id: s.id,
        vetId: s.vetId,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        slotMinutes: s.slotDurationMin,
        active: s.isActive,
      })),
    }));
  }

  public async getVetAvailableSlots(vetId: string, dateStr: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new AppError('El parámetro date debe tener formato YYYY-MM-DD', 400, 'INVALID_DATE');
    }

    const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
    const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);
    if (!Number.isFinite(dayStart.getTime())) {
      throw new AppError('Fecha inválida', 400, 'INVALID_DATE');
    }

    const vet = await prisma.user.findFirst({
      where: {
        id: vetId,
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        deletedAt: null,
      },
      select: { id: true, firstName: true, lastName: true },
    });

    if (!vet) {
      throw new AppError('Veterinario no encontrado', 404, 'VET_NOT_FOUND');
    }

    const dayOfWeek = dayStart.getUTCDay();
    const availability = await prisma.vetAvailabilitySlot.findMany({
      where: { vetId, dayOfWeek, isActive: true },
      orderBy: { startTime: 'asc' },
    });

    const bookedMeta = prisma.consultationMetadata?.findMany
      ? await prisma.consultationMetadata.findMany({
          where: {
            scheduledAt: { gte: dayStart, lte: dayEnd },
            consultation: {
              vetId,
              deletedAt: null,
              status: { in: [ConsultationStatus.WAITING, ConsultationStatus.ACTIVE] },
            },
          },
          select: { scheduledAt: true },
        })
      : [];

    const bookedFollowUps = prisma.followUp?.findMany
      ? await prisma.followUp.findMany({
          where: {
            vetId,
            status: FollowUpStatus.PENDING,
            dueAt: { gte: dayStart, lte: dayEnd },
          },
          select: { dueAt: true },
        })
      : [];

    const bookedTimestamps = [
      ...bookedMeta.map((b) => b.scheduledAt?.getTime()).filter((v): v is number => typeof v === 'number'),
      ...bookedFollowUps.map((f) => f.dueAt.getTime()),
    ];

    const slots: Array<{ startIso: string; label: string; available: boolean }> = [];
    for (const block of availability) {
      const startMin = timeToMinutes(block.startTime);
      const endMin = timeToMinutes(block.endTime);
      const step = Math.max(15, block.slotDurationMin || 30);

      for (let cursor = startMin; cursor + step <= endMin; cursor += step) {
        const label = minutesToTime(cursor);
        const startIso = new Date(`${dateStr}T${label}:00.000Z`).toISOString();
        const candidateMs = new Date(startIso).getTime();
        const hasConflict = bookedTimestamps.some(
          (bookedMs) => Math.abs(bookedMs - candidateMs) < step * 60 * 1000
        );
        slots.push({
          startIso,
          label,
          available: !hasConflict,
        });
      }
    }

    return { vetId, date: dateStr, slots };
  }

  public async createScheduledAppointment(clientUser: User, dto: CreateAppointmentDTO) {
    const scheduledDate = new Date(dto.scheduledAt);
    if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now() - 60_000) {
      throw new AppError('El turno debe programarse en una fecha futura', 400, 'INVALID_SCHEDULED_AT');
    }

    const pet = await prisma.pet.findFirst({
      where: {
        id: dto.petId,
        deletedAt: null,
        OR: [
          { ownerId: clientUser.id },
          ...(prisma.petCoOwner ? [{ coOwners: { some: { userId: clientUser.id } } }] : []),
        ],
      },
    });
    if (!pet) {
      throw new AppError('Mascota no encontrada o sin acceso', 404, 'PET_NOT_FOUND');
    }

    const vet = await prisma.user.findFirst({
      where: {
        id: dto.vetId,
        role: Role.VET,
        vetStatus: VetStatus.APPROVED,
        deletedAt: null,
      },
    });
    if (!vet) {
      throw new AppError('Veterinario no encontrado o no habilitado', 404, 'VET_NOT_FOUND');
    }

    const conflictWindowStart = new Date(scheduledDate.getTime() - 15 * 60 * 1000);
    const conflictWindowEnd = new Date(scheduledDate.getTime() + 15 * 60 * 1000);
    const conflicting = prisma.consultationMetadata?.findFirst
      ? await prisma.consultationMetadata.findFirst({
          where: {
            scheduledAt: { gte: conflictWindowStart, lte: conflictWindowEnd },
            consultation: {
              vetId: dto.vetId,
              deletedAt: null,
              status: { in: [ConsultationStatus.WAITING, ConsultationStatus.ACTIVE] },
            },
          },
        })
      : null;

    if (conflicting) {
      throw new AppError('El horario seleccionado ya no está disponible', 409, 'SLOT_CONFLICT');
    }

    const formattedNotes =
      dto.symptoms && dto.symptoms.length > 0
        ? `${dto.notes.trim()} [Síntomas: ${dto.symptoms.join(', ')}]`
        : dto.notes.trim();

    const created = await prisma.$transaction(async (tx) => {
      const consultation = await tx.consultation.create({
        data: {
          clientId: clientUser.id,
          petId: dto.petId,
          vetId: dto.vetId,
          status: ConsultationStatus.WAITING,
          notes: formattedNotes,
        },
        include: {
          pet: true,
          vet: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              photoUrl: true,
            },
          },
        },
      });

      if (tx.consultationMetadata?.create) {
        await tx.consultationMetadata.create({
          data: {
            consultationId: consultation.id,
            scheduledAt: scheduledDate,
          },
        });
      }

      if (tx.consultationAuditLog?.create) {
        await tx.consultationAuditLog.create({
          data: {
            consultationId: consultation.id,
            eventType: 'SCHEDULED_CREATED',
            previousState: null,
            newState: ConsultationStatus.WAITING,
            actorId: clientUser.id,
            metadata: { scheduledAt: scheduledDate.toISOString(), vetId: dto.vetId },
          },
        });
      }

      return consultation;
    });

    await notificationsService
      .createAndDispatch(
        dto.vetId,
        'Nuevo turno programado',
        `${pet.name} tiene un turno programado para ${scheduledDate.toLocaleDateString('es-AR')}.`,
        'APPOINTMENT_SCHEDULED',
        { consultationId: created.id, scheduledAt: scheduledDate.toISOString() }
      )
      .catch(() => {});

    return {
      ...created,
      scheduledAt: scheduledDate.toISOString(),
    };
  }

  public async listFollowUps(requester: User) {
    const where =
      requester.role === Role.VET
        ? { vetId: requester.id }
        : requester.role === Role.ADMIN
        ? {}
        : {
            OR: [
              { clientId: requester.id },
              { pet: { coOwners: { some: { userId: requester.id } } } },
            ],
          };

    const items = await prisma.followUp.findMany({
      where,
      include: {
        pet: { select: { id: true, name: true, species: true } },
        vet: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { dueAt: 'asc' },
    });

    return items.map((item) => ({
      id: item.id,
      petId: item.petId,
      petName: item.pet?.name,
      vetId: item.vetId,
      vetName: item.vet ? `Dr. ${item.vet.firstName} ${item.vet.lastName}`.trim() : undefined,
      clientId: item.clientId,
      consultationId: item.consultationId,
      title: item.title,
      scheduledAt: item.dueAt.toISOString(),
      status: item.status,
      notes: item.notes,
      createdAt: item.createdAt.toISOString(),
    }));
  }

  public async createFollowUp(requester: User, dto: CreateFollowUpDTO) {
    if (requester.role !== Role.VET && requester.role !== Role.ADMIN) {
      throw new AppError('Solo veterinarios pueden programar seguimientos', 403, 'FORBIDDEN');
    }

    const pet = await prisma.pet.findFirst({
      where: { id: dto.petId, deletedAt: null },
    });
    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    if (dto.consultationId) {
      const consultation = await prisma.consultation.findFirst({
        where: { id: dto.consultationId, deletedAt: null },
      });
      if (!consultation) {
        throw new AppError('Consulta no encontrada', 404, 'CONSULTATION_NOT_FOUND');
      }
    }

    const dueAt = new Date(dto.dueAt);
    const created = await prisma.followUp.create({
      data: {
        petId: pet.id,
        consultationId: dto.consultationId ?? null,
        vetId: requester.id,
        clientId: pet.ownerId,
        title: dto.title.trim(),
        notes: dto.notes?.trim() || null,
        dueAt,
        status: FollowUpStatus.PENDING,
      },
      include: {
        pet: { select: { id: true, name: true } },
        vet: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    await notificationsService
      .createAndDispatch(
        pet.ownerId,
        'Propuesta de seguimiento clínico',
        `${pet.name}: ${created.title} propuesto para ${dueAt.toLocaleDateString('es-AR')} a las ${dueAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}. Confirmá disponibilidad o proponé otro horario desde tu agenda.`,
        'FOLLOW_UP_SCHEDULED',
        { followUpId: created.id, petId: pet.id, dueAt: dueAt.toISOString() }
      )
      .catch(() => {});

    return {
      id: created.id,
      petId: created.petId,
      petName: created.pet?.name,
      vetId: created.vetId,
      vetName: created.vet ? `Dr. ${created.vet.firstName} ${created.vet.lastName}`.trim() : undefined,
      clientId: created.clientId,
      consultationId: created.consultationId,
      title: created.title,
      scheduledAt: created.dueAt.toISOString(),
      status: created.status,
      notes: created.notes,
      createdAt: created.createdAt.toISOString(),
    };
  }

  public async updateFollowUp(id: string, requester: User, dto: UpdateFollowUpDTO) {
    const existing = await prisma.followUp.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError('Seguimiento no encontrado', 404, 'FOLLOW_UP_NOT_FOUND');
    }

    const isOwnerVet = existing.vetId === requester.id;
    const isClient = existing.clientId === requester.id;
    const isAdmin = requester.role === Role.ADMIN;

    if (!isOwnerVet && !isClient && !isAdmin) {
      throw new AppError('Acceso denegado', 403, 'FORBIDDEN');
    }

    if (isClient && !isOwnerVet && !isAdmin && dto.status === FollowUpStatus.COMPLETED) {
      throw new AppError('Solo el veterinario puede marcar un seguimiento como completado', 403, 'FORBIDDEN');
    }

    const nextStatus = dto.status
      ? (dto.status as FollowUpStatus)
      : existing.status;

    const updated = await prisma.followUp.update({
      where: { id },
      data: {
        status: nextStatus,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
        title: dto.title ? dto.title.trim() : undefined,
        notes: dto.notes !== undefined ? dto.notes : undefined,
        completedAt: nextStatus === FollowUpStatus.COMPLETED ? new Date() : undefined,
      },
    });

    if (isClient && !isOwnerVet && (dto.dueAt || nextStatus === FollowUpStatus.CANCELLED)) {
      const dueStr = `${updated.dueAt.toLocaleDateString('es-AR')} ${updated.dueAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
      await notificationsService
        .createAndDispatch(
          existing.vetId,
          nextStatus === FollowUpStatus.CANCELLED
            ? 'Seguimiento cancelado por el tutor'
            : 'El tutor propuso otro horario de seguimiento',
          nextStatus === FollowUpStatus.CANCELLED
            ? `El tutor informó que no podrá asistir al control "${updated.title}".`
            : `Para "${updated.title}", el tutor propuso el ${dueStr}.`,
          'FOLLOW_UP_UPDATED',
          { followUpId: updated.id, petId: updated.petId, dueAt: updated.dueAt.toISOString(), status: updated.status }
        )
        .catch(() => {});
    }

    return {
      id: updated.id,
      petId: updated.petId,
      vetId: updated.vetId,
      clientId: updated.clientId,
      consultationId: updated.consultationId,
      title: updated.title,
      scheduledAt: updated.dueAt.toISOString(),
      status: updated.status,
      notes: updated.notes,
      createdAt: updated.createdAt.toISOString(),
    };
  }
}

export const schedulingService = new SchedulingService();
