import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authenticate } from './auth.middleware';
import { passwordResetIpLimiter, passwordResetEmailLimiter } from '../../middlewares/rateLimiter';

const router = Router();
const controller = new AuthController();

router.post('/register', controller.register);
router.post('/login', controller.login);
router.post('/refresh', controller.refresh);
router.post('/logout', authenticate, controller.logout);
router.get('/me', authenticate, controller.me);
router.post('/verify-email', authenticate, controller.verifyEmail);
router.post('/resend-verification', authenticate, controller.resendVerification);

// Password recovery routes (hardened with IP & Email rate limiting)
router.post('/forgot-password', passwordResetIpLimiter, passwordResetEmailLimiter, controller.forgotPassword);
router.post('/verify-reset-code', passwordResetIpLimiter, passwordResetEmailLimiter, controller.verifyResetCode);
router.post('/reset-password', passwordResetIpLimiter, passwordResetEmailLimiter, controller.resetPassword);

export default router;
