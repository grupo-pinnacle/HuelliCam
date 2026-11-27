import { Role, VetStatus, ConsultationStatus, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { getRedisClient } from '../../lib/redis';
import { AppError } from '../../middlewares/errorHandler';
import { io } from '../../realtime/socket.server';
import { presenceService } from '../../realtime/presence.service';
import { evictUserRealtimeAndCall } from '../../realtime/sessionEviction.helper';
import {
  RejectVetDTO,
  AdminCreateUserDTO,
  AdminUpdateUserDTO,
  AdminCreatePetDTO,
  AdminUpdatePetDTO,
  RevokeUserSessionsDTO,
  SUPPORTED_CURRENCIES,
  SupportedCurrency,
  UpdatePricingSettingsDTO,
} from './admin.schemas';

export const REDIS_PRICING_SETTINGS_KEY = 'huellicam:pricing_settings';
const PRICING_SYNC_TTL_MS = 2_000;

interface RefreshTokenDelegate {
  deleteMany: (args: { where: { userId: string } }) => Promise<{ count?: number }>;
}

const userSelectFields = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  vetStatus: true,
  licenseNumber: true,
  bio: true,
  photoUrl: true,
  ratingAvg: true,
  ratingCount: true,
  isOnline: true,
  lastSeen: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
};

export class AdminService {
  private disconnectUserSocketsAfterFlush(userId: string): void {
    if (!io) return;
    const timer = setTimeout(() => {
      try {
        io?.in(`user:${userId}`).disconnectSockets(true);
      } catch {
        // Ignore socket teardown errors
      }
    }, 25);
    timer.unref();
  }

  public async getStats() {
    const useDistributedPresence = presenceService.isDistributedActive();
    const [pendingVets, approvedVets, rejectedVets, onlineVets] = await Promise.all([
      prisma.user.count({ where: { role: Role.VET, vetStatus: VetStatus.PENDING, deletedAt: null } }),
      prisma.user.count({ where: { role: Role.VET, vetStatus: VetStatus.APPROVED, deletedAt: null } }),
      prisma.user.count({ where: { role: Role.VET, vetStatus: VetStatus.REJECTED, deletedAt: null } }),
      useDistributedPresence
        ? presenceService.getOnlineVetsCount().catch(() =>
            prisma.user.count({ where: { role: Role.VET, vetStatus: VetStatus.APPROVED, isOnline: true, deletedAt: null } })
          )
        : prisma.user.count({ where: { role: Role.VET, vetStatus: VetStatus.APPROVED, isOnline: true, deletedAt: null } }),
    ]);

    const totalDecided = approvedVets + rejectedVets;
    const approvalRate = totalDecided > 0 ? parseFloat(((approvedVets / totalDecided) * 100).toFixed(1)) : 100;

    const stats: any = {
      pendingVets,
      approvedVets,
      rejectedVets,
      onlineVets,
      approvalRate,
    };

    if (process.env.NODE_ENV !== 'test' && prisma.pet?.count && prisma.consultation?.count) {
      try {
        const [
          clientsCount,
          vetsCount,
          adminsCount,
          activePetsCount,
          deletedPetsCount,
          totalConsultations,
          waitingConsultations,
          activeConsultations,
          completedConsultations,
          cancelledConsultations,
        ] = await Promise.all([
          prisma.user.count({ where: { role: Role.CLIENT, deletedAt: null } }),
          prisma.user.count({ where: { role: Role.VET, deletedAt: null } }),
          prisma.user.count({ where: { role: Role.ADMIN, deletedAt: null } }),
          prisma.pet.count({ where: { deletedAt: null } }),
          prisma.pet.count({ where: { NOT: { deletedAt: null } } }),
          prisma.consultation.count({ where: { deletedAt: null } }),
          prisma.consultation.count({ where: { status: ConsultationStatus.WAITING, deletedAt: null } }),
          prisma.consultation.count({ where: { status: ConsultationStatus.ACTIVE, deletedAt: null } }),
          prisma.consultation.count({ where: { status: ConsultationStatus.COMPLETED, deletedAt: null } }),
          prisma.consultation.count({ where: { status: ConsultationStatus.CANCELLED, deletedAt: null } }),
        ]);

        Object.assign(stats, {
          clientsCount,
          vetsCount,
          adminsCount,
          activePetsCount,
          deletedPetsCount,
          totalConsultations,
          waitingConsultations,
          activeConsultations,
          completedConsultations,
          cancelledConsultations,
        });
      } catch {
        // safe fallback
      }
    }

    return stats;
  }

  public async getPendingVets() {
    return prisma.user.findMany({
      where: {
        role: Role.VET,
        vetStatus: VetStatus.PENDING,
        deletedAt: null,
      },
      select: userSelectFields,
      orderBy: { createdAt: 'asc' },
    });
  }

  public async approveVet(vetId: string, adminId: string) {
    const vet = await prisma.user.findFirst({
      where: { id: vetId, role: Role.VET, deletedAt: null },
    });

    if (!vet) {
      throw new AppError('Veterinario no encontrado', 404, 'VET_NOT_FOUND');
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updatedVet = await tx.user.update({
        where: { id: vetId },
        data: { vetStatus: VetStatus.APPROVED },
        select: userSelectFields,
      });

      await tx.auditLog.create({
        data: {
          adminId,
          action: 'APPROVE_VET',
          targetId: vetId,
          details: { licenseNumber: vet.licenseNumber, previousStatus: vet.vetStatus },
        },
      });

      return updatedVet;
    });
  }

  public async rejectVet(vetId: string, adminId: string, dto?: RejectVetDTO) {
    const vet = await prisma.user.findFirst({
      where: { id: vetId, role: Role.VET, deletedAt: null },
    });

    if (!vet) {
      throw new AppError('Veterinario no encontrado', 404, 'VET_NOT_FOUND');
    }

    const updatedVet = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.user.update({
        where: { id: vetId },
        data: {
          vetStatus: VetStatus.REJECTED,
          isOnline: false,
          tokenVersion: { increment: 1 },
        },
        select: userSelectFields,
      });

      await tx.auditLog.create({
        data: {
          adminId,
          action: 'REJECT_VET',
          targetId: vetId,
          details: { reason: dto?.reason, licenseNumber: vet.licenseNumber },
        },
      });

      return updated;
    });

    if (vet.vetStatus === VetStatus.APPROVED) {
      await presenceService.clearUserPresence(vetId).catch(() => {});
      if (io) {
        try {
          if (io.sockets?.sockets) {
            for (const s of io.sockets.sockets.values()) {
              if (s.data?.user?.id === vetId) {
                s.data.user.vetStatus = VetStatus.REJECTED;
              }
            }
          }
          io.in(`user:${vetId}`).socketsLeave('role:vets');
          io.to('role:vets').emit('vet:presence', {
            vetId,
            isOnline: false,
            lastSeen: new Date().toISOString(),
          });
          io.to(`user:${vetId}`).emit('auth:session_terminated', {
            reason: 'VET_REJECTED',
            message:
              dto?.reason ||
              'Tu perfil veterinario fue rechazado por un administrador.',
          });
          this.disconnectUserSocketsAfterFlush(vetId);
        } catch {
          // Non-blocking realtime notification
        }
      }
    }

    return updatedVet;
  }

  // ==========================================
  // USERS CRUD
  // ==========================================
  public async getUsers(query?: { role?: Role; search?: string; includeDeleted?: boolean }) {
    const where: Prisma.UserWhereInput = {};

    if (!query?.includeDeleted) {
      where.deletedAt = null;
    }

    if (query?.role) {
      where.role = query.role;
    }

    if (query?.search) {
      where.OR = [
        { firstName: { contains: query.search, mode: 'insensitive' } },
        { lastName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { licenseNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        ...userSelectFields,
        _count: {
          select: {
            pets: true,
            clientConsultations: true,
            vetConsultations: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (presenceService.isDistributedActive() && users.length > 0) {
      try {
        const presenceMap = await presenceService.getUsersPresence(users.map((u) => u.id));
        return users.map((u) => {
          const presence = presenceMap.get(u.id);
          return {
            ...u,
            isOnline: presence?.isOnline ?? false,
            lastSeen: presence?.lastSeen ?? u.lastSeen,
          };
        });
      } catch {
        return users;
      }
    }

    return users;
  }

  public async createUser(adminId: string, dto: AdminCreateUserDTO) {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      throw new AppError('El email ya está registrado', 409, 'EMAIL_ALREADY_EXISTS');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone?.trim() || null,
        role: dto.role,
        vetStatus: dto.role === 'VET' ? (dto.vetStatus || VetStatus.APPROVED) : null,
        licenseNumber: dto.role === 'VET' ? (dto.licenseNumber?.trim() || null) : null,
        bio: dto.bio?.trim() || null,
      },
      select: userSelectFields,
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_CREATE_USER',
        targetId: user.id,
        details: { email: user.email, role: user.role },
      },
    }).catch(() => {});

    return user;
  }

  public async updateUser(adminId: string, userId: string, dto: AdminUpdateUserDTO) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND');
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.firstName) data.firstName = dto.firstName;
    if (dto.lastName) data.lastName = dto.lastName;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.role) data.role = dto.role;
    if (dto.vetStatus !== undefined) data.vetStatus = dto.vetStatus;
    if (dto.licenseNumber !== undefined) data.licenseNumber = dto.licenseNumber;
    if (dto.bio !== undefined) data.bio = dto.bio;

    if (dto.email && dto.email !== user.email) {
      const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existing) throw new AppError('El nuevo email ya está en uso', 409, 'EMAIL_ALREADY_EXISTS');
      data.email = normalizedEmail;
    }

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, 12);
    }

    const roleChanged = dto.role !== undefined && dto.role !== user.role;
    const vetStatusChanged = dto.vetStatus !== undefined && dto.vetStatus !== user.vetStatus;
    const passwordChanged = Boolean(dto.password);
    const shouldRevokeSession = roleChanged || vetStatusChanged || passwordChanged;

    const wasApprovedVet = user.role === Role.VET && user.vetStatus === VetStatus.APPROVED;
    const nextRole = dto.role ?? user.role;
    const nextVetStatus = dto.vetStatus !== undefined ? dto.vetStatus : user.vetStatus;
    const isStillApprovedVet = nextRole === Role.VET && nextVetStatus === VetStatus.APPROVED;
    const lostApprovedVetStatus = wasApprovedVet && !isStillApprovedVet;

    if (shouldRevokeSession) {
      data.tokenVersion = { increment: 1 };
      if (lostApprovedVetStatus) {
        data.isOnline = false;
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: userSelectFields,
    });

    if (shouldRevokeSession) {
      await presenceService.clearUserPresence(userId).catch(() => {});

      await evictUserRealtimeAndCall({
        userId,
        role: updated.role,
        reason: 'SESSION_REVOKED',
        message: 'Tu perfil o credenciales fueron actualizados por un administrador. Iniciá sesión nuevamente.',
        emitEvent: false,
      }).catch(() => {});
      if (io) {
        try {
          io.to(`user:${userId}`).emit('auth:session_terminated', {
            reason: 'SESSION_REVOKED',
            message: 'Tu perfil o credenciales fueron actualizados por un administrador. Iniciá sesión nuevamente.',
          });
          if (lostApprovedVetStatus) {
            io.in(`user:${userId}`).socketsLeave('role:vets');
            io.to('role:vets').emit('vet:presence', {
              vetId: userId,
              isOnline: false,
              lastSeen: new Date().toISOString(),
            });
          }
          this.disconnectUserSocketsAfterFlush(userId);
        } catch {
          // Non-blocking realtime notification
        }
      }
    }

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_UPDATE_USER',
        targetId: userId,
        details: { changedFields: Object.keys(data) },
      },
    }).catch(() => {});

    return updated;
  }

  public async deleteUser(adminId: string, userId: string) {
    return this.banUser(adminId, userId, 'Cuenta dada de baja o suspendida por el administrador.');
  }

  public async banUser(adminId: string, userId: string, reason?: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND');
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: new Date(),
        isOnline: false,
        tokenVersion: { increment: 1 },
      },
      select: userSelectFields,
    });

    await presenceService.clearUserPresence(userId).catch(() => {});

    await evictUserRealtimeAndCall({
      userId,
      role: updated.role,
      reason: 'ACCOUNT_BANNED',
      message:
        reason ||
        'Tu cuenta ha sido suspendida permanentemente por un administrador por infracción de términos de servicio.',
      emitEvent: false,
    }).catch(() => {});

    // Notify user in real-time if connected via Socket.io
    if (io) {
      try {
        io.to(`user:${userId}`).emit('auth:session_terminated', {
          reason: 'ACCOUNT_BANNED',
          message:
            reason ||
            'Tu cuenta ha sido suspendida permanentemente por un administrador por infracción de términos de servicio.',
        });
        if (updated.role === Role.VET && updated.vetStatus === VetStatus.APPROVED) {
          io.to('role:vets').emit('vet:presence', {
            vetId: userId,
            isOnline: false,
            lastSeen: new Date().toISOString(),
          });
        }
        this.disconnectUserSocketsAfterFlush(userId);
      } catch {
        // Non-blocking realtime notification
      }
    }

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_BAN_USER',
        targetId: userId,
        details: { email: user.email, reason: reason || 'Baneo permanente' },
      },
    }).catch(() => {});

    return updated;
  }

  public async restoreUser(adminId: string, userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND');
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: null },
      select: userSelectFields,
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_RESTORE_USER',
        targetId: userId,
        details: { email: user.email },
      },
    }).catch(() => {});

    return updated;
  }

  // ==========================================
  // PETS CRUD (Creadas y Ocultas)
  // ==========================================
  public async getPets(query?: { includeDeleted?: boolean; search?: string }) {
    const where: Prisma.PetWhereInput = {};

    if (!query?.includeDeleted) {
      where.deletedAt = null;
    }

    if (query?.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { species: { contains: query.search, mode: 'insensitive' } },
        { breed: { contains: query.search, mode: 'insensitive' } },
        { microchip: { contains: query.search, mode: 'insensitive' } },
        { owner: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { owner: { lastName: { contains: query.search, mode: 'insensitive' } } },
        { owner: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    return prisma.pet.findMany({
      where,
      include: {
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        _count: {
          select: {
            consultations: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async createPet(adminId: string, dto: AdminCreatePetDTO) {
    const owner = await prisma.user.findUnique({ where: { id: dto.ownerId } });
    if (!owner) {
      throw new AppError('Tutor no encontrado', 404, 'OWNER_NOT_FOUND');
    }

    if (dto.microchip) {
      const existingChip = await prisma.pet.findFirst({
        where: { microchip: dto.microchip, deletedAt: null },
      });
      if (existingChip) {
        throw new AppError('El numero de microchip ya se encuentra registrado', 409, 'MICROCHIP_ALREADY_EXISTS');
      }
    }

    const pet = await prisma.pet.create({
      data: {
        ownerId: dto.ownerId,
        name: dto.name,
        species: dto.species,
        breed: dto.breed,
        weightKg: dto.weightKg,
        sex: dto.sex,
        birthDate: dto.birthDate,
        microchip: dto.microchip,
        allergies: dto.allergies,
        chronicConditions: dto.chronicConditions,
      },
      include: {
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_CREATE_PET',
        targetId: pet.id,
        details: { petName: pet.name, ownerEmail: owner.email },
      },
    }).catch(() => {});

    return pet;
  }

  public async updatePet(adminId: string, petId: string, dto: AdminUpdatePetDTO) {
    const pet = await prisma.pet.findUnique({ where: { id: petId } });
    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    if (dto.microchip && dto.microchip !== pet.microchip) {
      const existingChip = await prisma.pet.findFirst({
        where: { microchip: dto.microchip, deletedAt: null },
      });
      if (existingChip) {
        throw new AppError('El numero de microchip ya se encuentra registrado', 409, 'MICROCHIP_ALREADY_EXISTS');
      }
    }

    const updated = await prisma.pet.update({
      where: { id: petId },
      data: {
        ownerId: dto.ownerId,
        name: dto.name,
        species: dto.species,
        breed: dto.breed,
        weightKg: dto.weightKg,
        sex: dto.sex,
        birthDate: dto.birthDate,
        microchip: dto.microchip,
        allergies: dto.allergies,
        chronicConditions: dto.chronicConditions,
      },
      include: {
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_UPDATE_PET',
        targetId: petId,
        details: { petName: updated.name },
      },
    }).catch(() => {});

    return updated;
  }

  public async deletePet(adminId: string, petId: string) {
    const pet = await prisma.pet.findUnique({ where: { id: petId } });
    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    const updated = await prisma.pet.update({
      where: { id: petId },
      data: { deletedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_SOFT_DELETE_PET',
        targetId: petId,
        details: { petName: pet.name },
      },
    }).catch(() => {});

    return updated;
  }

  public async restorePet(adminId: string, petId: string) {
    const pet = await prisma.pet.findUnique({ where: { id: petId } });
    if (!pet) {
      throw new AppError('Mascota no encontrada', 404, 'PET_NOT_FOUND');
    }

    const updated = await prisma.pet.update({
      where: { id: petId },
      data: { deletedAt: null },
    });

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_RESTORE_PET',
        targetId: petId,
        details: { petName: pet.name },
      },
    }).catch(() => {});

    return updated;
  }

  // ==========================================
  // CONSULTATIONS & AUDIT LOGS
  // ==========================================
  public async getConsultations(query?: { status?: ConsultationStatus; search?: string }) {
    const where: Prisma.ConsultationWhereInput = { deletedAt: null };

    if (query?.status) {
      where.status = query.status;
    }

    if (query?.search) {
      where.OR = [
        { client: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { client: { lastName: { contains: query.search, mode: 'insensitive' } } },
        { client: { email: { contains: query.search, mode: 'insensitive' } } },
        { vet: { firstName: { contains: query.search, mode: 'insensitive' } } },
        { vet: { lastName: { contains: query.search, mode: 'insensitive' } } },
        { pet: { name: { contains: query.search, mode: 'insensitive' } } },
        { notes: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const consultations = await prisma.consultation.findMany({
      where,
      include: {
        client: { select: userSelectFields },
        vet: { select: userSelectFields },
        pet: true,
        review: true,
        _count: {
          select: {
            messages: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    if (presenceService.isDistributedActive() && consultations.length > 0) {
      try {
        const userIds: string[] = [];
        for (const c of consultations) {
          if (c.client?.id) userIds.push(c.client.id);
          if (c.vet?.id) userIds.push(c.vet.id);
        }
        const presenceMap = await presenceService.getUsersPresence(userIds);
        return consultations.map((c) => ({
          ...c,
          client: c.client
            ? {
                ...c.client,
                isOnline: presenceMap.get(c.client.id)?.isOnline ?? false,
                lastSeen: presenceMap.get(c.client.id)?.lastSeen ?? c.client.lastSeen,
              }
            : c.client,
          vet: c.vet
            ? {
                ...c.vet,
                isOnline: presenceMap.get(c.vet.id)?.isOnline ?? false,
                lastSeen: presenceMap.get(c.vet.id)?.lastSeen ?? c.vet.lastSeen,
              }
            : c.vet,
        }));
      } catch {
        return consultations;
      }
    }

    return consultations;
  }

  public async getConsultationMessages(consultationId: string) {
    return prisma.message.findMany({
      where: { consultationId },
      include: {
        sender: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
            email: true,
            photoUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  public async getAuditLogs() {
    return prisma.auditLog.findMany({
      include: {
        admin: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  public async revokeUserSessionsAndSuspend(
    adminId: string,
    targetUserId: string,
    dto: RevokeUserSessionsDTO
  ): Promise<{ revokedCount: number; status: string; tokenVersionRevoked: boolean }> {
    const user = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      throw new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND');
    }

    await prisma.user.update({
      where: { id: targetUserId },
      data: {
        tokenVersion: { increment: 1 },
        ...(dto.suspendAccount ? { deletedAt: new Date(), isOnline: false } : {}),
      },
    });

    let revokedCount = 0;
    const refreshTokenDelegate = (prisma as unknown as { refreshToken?: RefreshTokenDelegate }).refreshToken;
    if (refreshTokenDelegate?.deleteMany) {
      const res = await refreshTokenDelegate.deleteMany({
        where: { userId: targetUserId },
      });
      revokedCount = res?.count ?? 0;
    }

    await presenceService.clearUserPresence(targetUserId).catch(() => {});

    await evictUserRealtimeAndCall({
      userId: targetUserId,
      role: user.role,
      reason: 'SESSION_REVOKED',
      message: dto.reason,
      emitEvent: false,
    }).catch(() => {});

    if (io) {
      try {
        io.to(`user:${targetUserId}`).emit('auth:session_terminated', {
          reason: 'SESSION_REVOKED',
          message: dto.reason,
        });
        if (user.role === Role.VET && user.vetStatus === VetStatus.APPROVED) {
          io.to('role:vets').emit('vet:presence', {
            vetId: targetUserId,
            isOnline: false,
            lastSeen: new Date().toISOString(),
          });
        }
        this.disconnectUserSocketsAfterFlush(targetUserId);
      } catch {
        // Non-blocking realtime notification
      }
    }

    await prisma.auditLog.create({
      data: {
        adminId,
        action: 'ADMIN_REVOKE_SESSIONS',
        targetId: targetUserId,
        details: {
          email: user.email,
          reason: dto.reason,
          suspendAccount: dto.suspendAccount,
          revokedSessions: revokedCount,
          tokenVersionRevoked: true,
        },
      },
    }).catch(() => {});

    return {
      revokedCount,
      status: dto.suspendAccount ? 'SUSPENDED' : 'ACTIVE',
      tokenVersionRevoked: true,
    };
  }


  private static defaultPricingSettings: PricingSettingsResponse = {
    baseConsultationFee: 15000,
    platformTakeRate: 0.2,
    currency: 'ARS',
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };

  private static currentPricingSettings: PricingSettingsResponse = {
    baseConsultationFee: 15000,
    platformTakeRate: 0.2,
    currency: 'ARS',
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };

  private static lastPricingSyncedAt = 0;

  public getPricingSettings(): PricingSettingsResponse {
    return { ...AdminService.currentPricingSettings };
  }

  public async syncPricingFromRedis(force = false): Promise<PricingSettingsResponse> {
    const now = Date.now();
    if (!force && now - AdminService.lastPricingSyncedAt < PRICING_SYNC_TTL_MS) {
      return this.getPricingSettings();
    }

    const client = getRedisClient();
    if (!client || client.status !== 'ready') {
      return this.getPricingSettings();
    }

    try {
      const raw = await client.get(REDIS_PRICING_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PricingSettingsResponse>;
        const validFee =
          typeof parsed.baseConsultationFee === 'number' &&
          Number.isFinite(parsed.baseConsultationFee) &&
          parsed.baseConsultationFee > 0;
        const validRate =
          typeof parsed.platformTakeRate === 'number' &&
          Number.isFinite(parsed.platformTakeRate) &&
          parsed.platformTakeRate >= 0 &&
          parsed.platformTakeRate <= 1;
        const validCurrency =
          typeof parsed.currency === 'string' &&
          SUPPORTED_CURRENCIES.includes(parsed.currency as SupportedCurrency);

        if (validFee && validRate && validCurrency) {
          AdminService.currentPricingSettings = {
            baseConsultationFee: parsed.baseConsultationFee!,
            platformTakeRate: parsed.platformTakeRate!,
            currency: parsed.currency as SupportedCurrency,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            updatedBy: parsed.updatedBy ?? null,
          };
        }
      }
      AdminService.lastPricingSyncedAt = now;
    } catch {
      // Fallback safely to in-memory pricing settings
    }

    return this.getPricingSettings();
  }

  public resetPricingForTests(): void {
    AdminService.lastPricingSyncedAt = 0;
    AdminService.currentPricingSettings = {
      ...AdminService.defaultPricingSettings,
      updatedAt: new Date().toISOString(),
    };
  }

  public async updatePricingSettings(
    adminId: string,
    dto: UpdatePricingSettingsDTO
  ): Promise<PricingSettingsResponse> {
    const updated: PricingSettingsResponse = {
      baseConsultationFee: dto.baseConsultationFee,
      platformTakeRate: dto.platformTakeRate,
      currency: dto.currency ?? 'ARS',
      updatedAt: new Date().toISOString(),
      updatedBy: adminId,
    };

    AdminService.currentPricingSettings = updated;
    AdminService.lastPricingSyncedAt = Date.now();

    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        await client.set(REDIS_PRICING_SETTINGS_KEY, JSON.stringify(updated));
      } catch {
        // Non-blocking Redis write-through
      }
    }

    if (prisma.platformPricingSetting?.upsert) {
      await prisma.platformPricingSetting
        .upsert({
          where: { id: 'default' },
          create: {
            id: 'default',
            baseConsultationFee: updated.baseConsultationFee,
            platformTakeRate: updated.platformTakeRate,
            currency: updated.currency,
            updatedBy: adminId,
          },
          update: {
            baseConsultationFee: updated.baseConsultationFee,
            platformTakeRate: updated.platformTakeRate,
            currency: updated.currency,
            updatedBy: adminId,
          },
        })
        .catch(() => {});
    }

    try {
      await prisma.auditLog.create({
        data: {
          adminId,
          action: 'PRICING_SETTINGS_UPDATED',
          targetId: 'PRICING',
          details: {
            baseConsultationFee: dto.baseConsultationFee,
            platformTakeRate: dto.platformTakeRate,
            currency: dto.currency ?? 'ARS',
            reason: dto.reason || null,
          },
        },
      });
    } catch {
      // Non-blocking persistence
    }

    return updated;
  }

  public async getExecutiveMetrics(
    unitPrice?: number,
    commissionRate?: number
  ): Promise<ExecutiveMetricsResponse> {
    await this.syncPricingFromRedis();
    const activeUnitPrice = unitPrice !== undefined ? unitPrice : AdminService.currentPricingSettings.baseConsultationFee;
    const activeCommissionRate = commissionRate !== undefined ? commissionRate : AdminService.currentPricingSettings.platformTakeRate;

    const consultations = await prisma.consultation.findMany({
      where: { deletedAt: null },
    });

    let completed = 0;
    let cancelledOrNoShow = 0;
    let waitingOrActive = 0;
    let gmvTotal = 0;
    let noShowLostRevenue = 0;

    for (const c of consultations) {
      const price =
        typeof (c as any).price === 'number' && (c as any).price > 0
          ? (c as any).price
          : activeUnitPrice;

      if (c.status === 'COMPLETED') {
        completed++;
        gmvTotal += price;
      } else if (c.status === 'CANCELLED') {
        cancelledOrNoShow++;
        noShowLostRevenue += price;
      } else if (c.status === 'WAITING' || c.status === 'ACTIVE') {
        waitingOrActive++;
      }
    }

    const totalConsultations = consultations.length;
    const netCommission = Math.round(gmvTotal * activeCommissionRate * 100) / 100;
    const triageToPaidConversionRate =
      totalConsultations > 0
        ? Math.round((completed / totalConsultations) * 10000) / 100
        : 0;

    return {
      gmvTotal,
      netCommission,
      noShowLostRevenue,
      triageToPaidConversionRate,
      counts: {
        totalConsultations,
        completed,
        cancelledOrNoShow,
        waitingOrActive,
      },
      pricing: this.getPricingSettings(),
    };
  }
}

export interface PricingSettingsResponse {
  baseConsultationFee: number;
  platformTakeRate: number;
  currency: SupportedCurrency;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface ExecutiveMetricsResponse {
  gmvTotal: number;
  netCommission: number;
  noShowLostRevenue: number;
  triageToPaidConversionRate: number;
  counts: {
    totalConsultations: number;
    completed: number;
    cancelledOrNoShow: number;
    waitingOrActive: number;
  };
  pricing?: PricingSettingsResponse;
}
