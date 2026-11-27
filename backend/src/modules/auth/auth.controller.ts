import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  verifyResetCodeSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schemas';
import { passwordResetService } from './passwordReset.service';
import { AuthenticatedRequest } from './auth.middleware';
import { extractDeviceId } from '../../contracts/consultation.contract';
import { consultationsService } from '../consultations/consultations.service';
import { evictUserRealtimeAndCall } from '../../realtime/sessionEviction.helper';
import prisma from '../../lib/prisma';

const authService = new AuthService();

const isProduction = process.env.NODE_ENV === 'production';
const cookieSecure = process.env.COOKIE_SECURE !== undefined
  ? process.env.COOKIE_SECURE === 'true'
  : isProduction;
const cookieSameSite = (process.env.COOKIE_SAME_SITE as 'none' | 'lax' | 'strict') ||
  (isProduction ? 'none' : 'lax');
const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

export const setRefreshCookie = (res: Response, refreshToken: string) => {
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/api/auth',
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });
};

export class AuthController {
  public register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = registerSchema.parse(req.body);
      const { user, tokens } = await authService.register(validated);

      setRefreshCookie(res, tokens.refreshToken);

      const isMobile = req.headers['x-client-platform'] === 'mobile';

      res.status(201).json({
        success: true,
        data: {
          accessToken: tokens.accessToken,
          ...(isMobile ? { refreshToken: tokens.refreshToken } : {}),
          user,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = loginSchema.parse(req.body);
      const { user, tokens } = await authService.login(validated);

      const rawDeviceId = extractDeviceId(req.headers['x-device-id']);
      let handoffResult: Awaited<ReturnType<typeof consultationsService.handoffTutorDevice>> | null =
        null;

      if (
        user.role === 'CLIENT' &&
        rawDeviceId &&
        typeof prisma.consultation?.findFirst === 'function'
      ) {
        handoffResult = await consultationsService
          .handoffTutorDevice(user.id, rawDeviceId)
          .catch(() => null);
      }

      const isHandoffSwap = Boolean(
        handoffResult?.hasActiveConsultation &&
          handoffResult?.didSwapDevice &&
          handoffResult?.revokedDeviceId
      );

      await evictUserRealtimeAndCall({
        userId: user.id,
        role: user.role,
        reason: isHandoffSwap ? 'SESSION_MIGRATED_NEW_DEVICE' : 'CONCURRENT_LOGIN',
        message: isHandoffSwap
          ? 'Tu consulta activa fue transferida a otro dispositivo.'
          : 'Se ha iniciado sesión desde otro dispositivo. Tu sesión ha sido finalizada por seguridad.',
        consultationId: handoffResult?.consultationId ?? null,
        revokedDeviceId: isHandoffSwap ? handoffResult?.revokedDeviceId ?? null : null,
        excludeDeviceId: rawDeviceId,
      });

      setRefreshCookie(res, tokens.refreshToken);

      const isMobile = req.headers['x-client-platform'] === 'mobile';

      res.status(200).json({
        success: true,
        data: {
          accessToken: tokens.accessToken,
          ...(isMobile ? { refreshToken: tokens.refreshToken } : {}),
          user,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const isMobile = req.headers['x-client-platform'] === 'mobile';
      let refreshToken = req.cookies.refreshToken;

      if (isMobile) {
        const bodyData = refreshSchema.parse(req.body);
        if (bodyData.refreshToken) {
          refreshToken = bodyData.refreshToken;
        }
      }

      const { user, tokens } = await authService.refresh(refreshToken);

      setRefreshCookie(res, tokens.refreshToken);

      res.status(200).json({
        success: true,
        data: {
          accessToken: tokens.accessToken,
          ...(isMobile ? { refreshToken: tokens.refreshToken } : {}),
          user,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public logout = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.user) {
        await authService.logout(req.user.id);
      }
      res.clearCookie('refreshToken', {
        path: '/api/auth',
        httpOnly: true,
        secure: cookieSecure,
        sameSite: cookieSameSite,
        ...(cookieDomain ? { domain: cookieDomain } : {}),
      });
      res.status(200).json({
        success: true,
        message: 'Sesion cerrada exitosamente',
      });
    } catch (error) {
      next(error);
    }
  };

  public me = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const emailVerified = req.user ? await authService.isEmailVerified(req.user.id) : false;
      res.status(200).json({
        success: true,
        data: {
          user: req.user ? { ...AuthService.sanitizeUser(req.user), emailVerified } : null,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public verifyEmail = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = verifyEmailSchema.parse(req.body);
      const result = await authService.verifyEmailCode(req.user!, validated.code);
      res.status(200).json({
        success: true,
        data: result,
        message: 'Correo electrónico verificado correctamente.',
      });
    } catch (error) {
      next(error);
    }
  };

  public resendVerification = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await authService.issueEmailVerification(req.user!);
      res.status(200).json({
        success: true,
        message: 'Te reenviamos un código de verificación a tu correo.',
      });
    } catch (error) {
      next(error);
    }
  };

  public forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = forgotPasswordSchema.parse(req.body);
      await passwordResetService.requestReset(validated.email);
      res.status(200).json({
        success: true,
        message: 'Si el correo existe en nuestro sistema, recibirás un código de recuperación en breve.',
      });
    } catch (error) {
      next(error);
    }
  };

  public verifyResetCode = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = verifyResetCodeSchema.parse(req.body);
      await passwordResetService.verifyCode(validated.email, validated.code);
      res.status(200).json({
        success: true,
        message: 'Código verificado correctamente.',
      });
    } catch (error) {
      next(error);
    }
  };

  public resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = resetPasswordSchema.parse(req.body);
      await passwordResetService.resetPassword(validated.email, validated.code, validated.newPassword);
      res.status(200).json({
        success: true,
        message: 'Tu contraseña ha sido restablecida exitosamente. Ya podés iniciar sesión.',
      });
    } catch (error) {
      next(error);
    }
  };
}
