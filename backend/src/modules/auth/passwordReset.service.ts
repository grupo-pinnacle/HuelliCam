import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { getRedisClient } from '../../lib/redis';
import { AppError } from '../../middlewares/errorHandler';
import { emailService } from '../../services/email.service';
import { evictUserRealtimeAndCall } from '../../realtime/sessionEviction.helper';

const OTP_ATTEMPT_WINDOW_SEC = 10 * 60;
const otpAttemptsKey = (tokenId: string) => `huellicam:pwdreset:attempts:${tokenId}`;

interface LocalAttemptEntry {
  count: number;
  expiresAt: number;
}

export class PasswordResetService {
  private failedAttemptsMap = new Map<string, LocalAttemptEntry>();

  private async incrementFailedAttempts(tokenId: string): Promise<number> {
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        const key = otpAttemptsKey(tokenId);
        const count = await client.incr(key);
        if (count === 1) {
          await client.expire(key, OTP_ATTEMPT_WINDOW_SEC);
        }
        return count;
      } catch {
        // Fallback to local map on Redis transient failure
      }
    }

    const now = Date.now();
    const existing = this.failedAttemptsMap.get(tokenId);
    const activeCount = existing && existing.expiresAt > now ? existing.count : 0;
    const nextCount = activeCount + 1;
    this.failedAttemptsMap.set(tokenId, {
      count: nextCount,
      expiresAt: now + OTP_ATTEMPT_WINDOW_SEC * 1000,
    });
    return nextCount;
  }

  private async clearFailedAttempts(tokenId: string): Promise<void> {
    this.failedAttemptsMap.delete(tokenId);
    const client = getRedisClient();
    if (client && client.status === 'ready') {
      try {
        await client.del(otpAttemptsKey(tokenId));
      } catch {
        // Non-blocking Redis cleanup
      }
    }
  }

  /**
   * Genera un código de 6 dígitos seguro, lo guarda hasheado y envía el correo con Resend.
   */
  public async requestReset(emailInput: string): Promise<boolean> {
    const normalizedEmail = String(emailInput).trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    // OWASP: No revelar si el correo existe o no al cliente, pero solo enviar si existe
    if (!user || user.deletedAt) {
      return true;
    }

    // Rate limiting: máximo 5 solicitudes por 15 minutos por correo
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    const count = await prisma.passwordResetToken.count({
      where: { email: normalizedEmail, createdAt: { gte: fifteenMinAgo } },
    });
    if (count >= 5) {
      throw new AppError(
        'Demasiados intentos de recuperación de contraseña para este correo. Intente nuevamente en 15 minutos.',
        429,
        'TOO_MANY_REQUESTS'
      );
    }

    // Invalida tokens previos pendientes para este email
    await prisma.passwordResetToken.updateMany({
      where: { email: normalizedEmail, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Generar código numérico criptográfico de 6 dígitos
    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos (TTL <= 10 min)

    await prisma.passwordResetToken.create({
      data: {
        email: normalizedEmail,
        codeHash,
        expiresAt,
      },
    });

    // Enviar correo vía Resend
    await emailService.sendPasswordResetCode(normalizedEmail, user.firstName, code);
    return true;
  }

  /**
   * Valida el código de 6 dígitos ingresado por el usuario.
   * Invalida el token al 3er intento fallido.
   */
  public async verifyCode(emailInput: string, codeInput: string): Promise<boolean> {
    await this.verifyActiveToken(emailInput, codeInput);
    return true;
  }

  private async verifyActiveToken(emailInput: string, codeInput: string): Promise<{ id: string }> {
    const email = String(emailInput).toLowerCase().trim();
    const code = String(codeInput).trim();

    const activeToken = await prisma.passwordResetToken.findFirst({
      where: {
        email,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!activeToken) {
      throw new AppError('El código es inválido o ha expirado', 400, 'INVALID_RESET_CODE');
    }

    const isMatch = await bcrypt.compare(code, activeToken.codeHash);
    if (!isMatch) {
      const currentAttempts = await this.incrementFailedAttempts(activeToken.id);

      if (currentAttempts >= 3) {
        await this.clearFailedAttempts(activeToken.id);
        await prisma.passwordResetToken.updateMany({
          where: { id: activeToken.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        throw new AppError(
          'Has superado el número máximo de intentos. El código ha sido invalidado.',
          400,
          'MAX_ATTEMPTS_EXCEEDED'
        );
      }

      throw new AppError('El código ingresado es incorrecto', 400, 'INVALID_RESET_CODE');
    }

    await this.clearFailedAttempts(activeToken.id);
    return { id: activeToken.id };
  }

  /**
   * Restablece la contraseña tras verificar el código, e incrementa tokenVersion para revocar sesiones antiguas.
   */
  public async resetPassword(emailInput: string, codeInput: string, newPasswordInput: string): Promise<boolean> {
    const email = String(emailInput).toLowerCase().trim();
    const code = String(codeInput).trim();

    const verifiedToken = await this.verifyActiveToken(email, code);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt) {
      throw new AppError('Usuario no encontrado', 404, 'USER_NOT_FOUND');
    }

    const hashedPassword = await bcrypt.hash(newPasswordInput, 12);

    // Atomic single-use CAS consumption so concurrent reset requests with the same OTP cannot both succeed
    const consumed = await prisma.passwordResetToken.updateMany({
      where: { id: verifiedToken.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new AppError('El código es inválido o ya fue utilizado', 400, 'INVALID_RESET_CODE');
    }

    await prisma.passwordResetToken.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Actualizar contraseña e incrementar tokenVersion para forzar re-autenticación limpia
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
    });

    await evictUserRealtimeAndCall({
      userId: user.id,
      role: user.role,
      reason: 'SESSION_REVOKED',
      message: 'Tu contraseña ha sido restablecida. Iniciá sesión nuevamente.',
    }).catch(() => {});

    return true;
  }
}

export const passwordResetService = new PasswordResetService();
