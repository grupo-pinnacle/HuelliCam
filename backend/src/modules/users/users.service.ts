import bcrypt from 'bcryptjs';
import { Role, VetStatus } from '@prisma/client';
import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { AuthService } from '../auth/auth.service';
import { ChangePasswordDTO, UpdateProfileDTO } from './users.schemas';
import { io } from '../../realtime/socket.server';
import { presenceService } from '../../realtime/presence.service';
import { evictUserRealtimeAndCall } from '../../realtime/sessionEviction.helper';

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
};

export class UsersService {
  public async updateProfile(userId: string, data: UpdateProfileDTO) {
    const updateData: {
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      bio?: string | null;
      photoUrl?: string | null;
      isOnline?: boolean;
      lastSeen?: Date;
    } = {};

    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName !== undefined) updateData.lastName = data.lastName;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.bio !== undefined) updateData.bio = data.bio;
    if (data.photoUrl !== undefined) updateData.photoUrl = data.photoUrl;

    if (typeof data.isOnline === 'boolean') {
      updateData.isOnline = data.isOnline;
      if (!data.isOnline) {
        updateData.lastSeen = new Date();
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: userSelectFields,
    });

    if (typeof data.isOnline === 'boolean') {
      const isOnlineValue = data.isOnline;
      const lastSeenIso = (updated.lastSeen ?? new Date()).toISOString();

      try {
        await presenceService.setManualVetAvailability({
          userId,
          role: updated.role,
          vetStatus: updated.vetStatus,
          isOnline: isOnlineValue,
        });
      } catch {
        // Non-blocking presence sync when Redis is temporarily unavailable
      }

      try {
        if (updated.role === Role.VET && updated.vetStatus === VetStatus.APPROVED) {
          io?.to('role:vets').emit('vet:presence', {
            vetId: updated.id,
            isOnline: isOnlineValue,
            lastSeen: lastSeenIso,
          });
        }
      } catch {
        // Non-blocking realtime notification
      }
    }

    return updated;
  }

  public async changePassword(userId: string, data: ChangePasswordDTO) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.deletedAt) {
      throw new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND');
    }

    const validCurrent = await bcrypt.compare(data.currentPassword, user.password);
    if (!validCurrent) {
      // HTTP 400 (not 401) avoids triggering Axios refresh interceptor while logged in.
      throw new AppError('La contraseña actual es incorrecta', 400, 'INVALID_CURRENT_PASSWORD');
    }

    const hashedPassword = await bcrypt.hash(data.newPassword, 12);
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
    });

    await evictUserRealtimeAndCall({
      userId,
      role: updatedUser.role,
      reason: 'SESSION_REVOKED',
      message: 'Tu contraseña fue actualizada. Iniciá sesión nuevamente.',
    }).catch(() => {});

    return AuthService.generateTokens(updatedUser);
  }

  public async getTelemedicineConsent(userId: string) {
    const record = prisma.telemedicineConsent?.findFirst
      ? await prisma.telemedicineConsent
          .findFirst({
            where: { userId, version: '1.0' },
            orderBy: { acceptedAt: 'desc' },
          })
          .catch((err) => {
            if (isMissingTableError(err)) return null;
            throw err;
          })
      : null;

    return {
      accepted: Boolean(record),
      consent: record
        ? {
            id: record.id,
            userId: record.userId,
            version: record.version,
            acceptedAt: record.acceptedAt.toISOString(),
          }
        : null,
    };
  }

  public async acceptTelemedicineConsent(
    userId: string,
    meta: { version?: string; ipAddress?: string; userAgent?: string }
  ) {
    const version = meta.version || '1.0';
    const existing = await prisma.telemedicineConsent.findFirst({
      where: { userId, version },
    });
    if (existing) {
      return {
        id: existing.id,
        userId: existing.userId,
        version: existing.version,
        acceptedAt: existing.acceptedAt.toISOString(),
      };
    }

    const created = await prisma.telemedicineConsent.create({
      data: {
        userId,
        version,
        ipAddress: meta.ipAddress || null,
        userAgent: meta.userAgent || null,
      },
    });

    return {
      id: created.id,
      userId: created.userId,
      version: created.version,
      acceptedAt: created.acceptedAt.toISOString(),
    };
  }
}
