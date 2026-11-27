import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Role, VetStatus, User } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import { RegisterDTO, LoginDTO } from './auth.schemas';
import { config } from '../../config/env';
import { presenceService } from '../../realtime/presence.service';
import { io } from '../../realtime/socket.server';
import { evictUserRealtimeAndCall } from '../../realtime/sessionEviction.helper';
import { featureFlagsService } from '../admin/feature-flags.service';
import { emailService } from '../../services/email.service';

const JWT_SECRET = config.JWT_SECRET;
const JWT_REFRESH_SECRET = config.JWT_REFRESH_SECRET;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export interface TokenPayload {
  userId: string;
  role: Role;
  tokenVersion: number;
}

export class AuthService {
  private static hashVerificationCode(code: string): string {
    return crypto.createHash('sha256').update(code.trim()).digest('hex');
  }

  public async isEmailVerified(userId: string): Promise<boolean> {
    if (!prisma.emailVerificationToken?.findUnique) {
      return true;
    }
    const token = await prisma.emailVerificationToken.findUnique({ where: { userId } }).catch(() => null);
    if (!token) return true;
    return Boolean(token.verifiedAt);
  }

  public async issueEmailVerification(user: Pick<User, 'id' | 'email' | 'firstName'>): Promise<void> {
    if (!prisma.emailVerificationToken?.upsert) return;
    const rawCode = String(crypto.randomInt(100000, 1000000));
    const codeHash = AuthService.hashVerificationCode(rawCode);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFY_TTL_MS);

    await prisma.emailVerificationToken.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        email: user.email,
        codeHash,
        expiresAt,
        verifiedAt: null,
      },
      update: {
        email: user.email,
        codeHash,
        expiresAt,
        verifiedAt: null,
      },
    });

    await emailService.sendEmailVerificationCode(user.email, user.firstName || 'Usuario', rawCode).catch(() => false);
  }

  public async verifyEmailCode(user: User, code: string) {
    if (!prisma.emailVerificationToken?.findUnique) {
      return { emailVerified: true };
    }
    const record = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });
    if (!record) {
      return { emailVerified: true };
    }
    if (record.verifiedAt) {
      return { emailVerified: true };
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new AppError('El código de verificación expiró. Solicitá uno nuevo.', 400, 'VERIFICATION_CODE_EXPIRED');
    }
    const expectedHash = AuthService.hashVerificationCode(code);
    if (expectedHash !== record.codeHash) {
      throw new AppError('Código de verificación incorrecto.', 400, 'INVALID_VERIFICATION_CODE');
    }

    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { verifiedAt: new Date() },
    });

    return { emailVerified: true };
  }

  public static generateTokens(user: User) {
    const payload: TokenPayload = {
      userId: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion,
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    });

    const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  public static sanitizeUser(user: User) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...sanitized } = user;
    return sanitized;
  }

  public async register(dto: RegisterDTO) {
    await featureFlagsService.syncFromRedis();
    featureFlagsService.assertEnabled('NEW_REGISTRATIONS_ENABLED');

    const emailStr = String(dto.email).trim().toLowerCase();

    const existing = await prisma.user.findUnique({
      where: { email: emailStr },
    });

    if (existing) {
      if (existing.deletedAt) {
        throw new AppError(
          'Este correo pertenece a una cuenta dada de baja o suspendida',
          409,
          'EMAIL_ALREADY_EXISTS'
        );
      }
      throw new AppError('El email ya se encuentra registrado', 409, 'EMAIL_ALREADY_EXISTS');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);
    const vetStatus = dto.role === Role.VET ? (process.env.NODE_ENV === 'production' ? VetStatus.PENDING : VetStatus.APPROVED) : null;

    const user = await prisma.user.create({
      data: {
        email: emailStr,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone || null,
        role: dto.role,
        vetStatus,
        licenseNumber: dto.licenseNumber || null,
        bio: dto.bio || null,
      },
    });

    await this.issueEmailVerification(user).catch(() => {});

    const tokens = AuthService.generateTokens(user);
    return {
      user: {
        ...AuthService.sanitizeUser(user),
        emailVerified: false,
      },
      tokens,
    };
  }

  public async login(dto: LoginDTO) {
    const emailStr = String(dto.email).trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: emailStr },
    });

    if (!user) {
      throw new AppError('Credenciales invalidas', 401, 'INVALID_CREDENTIALS');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new AppError('Credenciales invalidas', 401, 'INVALID_CREDENTIALS');
    }

    if (user.deletedAt) {
      throw new AppError(
        'Tu cuenta ha sido dada de baja o suspendida por un administrador',
        403,
        'ACCOUNT_SUSPENDED'
      );
    }

    // Atomic session rotation: increment tokenVersion to invalidate existing active sessions (ADR-004 Single Session Concurrency)
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        tokenVersion: { increment: 1 },
      },
    });

    const emailVerified = await this.isEmailVerified(updatedUser.id);
    const tokens = AuthService.generateTokens(updatedUser);
    return {
      user: {
        ...AuthService.sanitizeUser(updatedUser),
        emailVerified,
      },
      tokens,
    };
  }

  public async refresh(tokenString: string) {
    if (!tokenString) {
      throw new AppError('Refresh token no provisto', 401, 'UNAUTHORIZED');
    }

    let payload: TokenPayload;
    try {
      payload = jwt.verify(tokenString, JWT_REFRESH_SECRET, {
        algorithms: ['HS256'],
      }) as TokenPayload;
    } catch (err) {
      throw new AppError('Refresh token invalido o expirado', 401, 'INVALID_REFRESH_TOKEN');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || user.deletedAt || user.tokenVersion !== payload.tokenVersion) {
      throw new AppError('Sesion revocada o invalida', 401, 'SESSION_REVOKED');
    }

    const tokens = AuthService.generateTokens(user);
    return { user: AuthService.sanitizeUser(user), tokens };
  }

  public async logout(userId: string) {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        tokenVersion: { increment: 1 },
        isOnline: false,
      },
    });

    await presenceService.clearUserPresence(userId).catch(() => {});

    await evictUserRealtimeAndCall({
      userId,
      role: updatedUser?.role,
      reason: 'SESSION_REVOKED',
      message: 'Sesión cerrada.',
      emitEvent: false,
    }).catch(() => {});

    try {
      if (io) {
        if (updatedUser?.role === Role.VET && updatedUser?.vetStatus === VetStatus.APPROVED) {
          io.to('role:vets').emit('vet:presence', {
            vetId: userId,
            isOnline: false,
            lastSeen: new Date().toISOString(),
          });
        }
        io.in(`user:${userId}`).disconnectSockets(true);
      }
    } catch {
      // Non-blocking socket cleanup on logout
    }
  }
}
