import rateLimit from 'express-rate-limit';

export const mediaUploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 20, // max 20 file uploads per hour per IP/user
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_UPLOADS',
      message: 'Límite de subida de archivos alcanzado (máximo 20 por hora). Intente más tarde.',
      timestamp: new Date().toISOString(),
    },
  },
});

export const consultationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 10, // max 10 triage requests per hour per IP/user
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_CONSULTATIONS',
      message: 'Límite de solicitudes de teleconsulta alcanzado (máximo 10 por hora).',
      timestamp: new Date().toISOString(),
    },
  },
});

export const passwordResetIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 5, // max 5 attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiadas solicitudes de recuperación de contraseña desde esta IP. Intente nuevamente en 15 minutos.',
      timestamp: new Date().toISOString(),
    },
  },
});

export const passwordResetEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes window
  max: 5, // max 5 attempts per 15 min per email
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const email = req.body?.email;
    return email ? String(email).trim().toLowerCase() : (req.ip || 'anonymous');
  },
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiadas solicitudes de recuperación de contraseña para este correo. Intente nuevamente en 15 minutos.',
      timestamp: new Date().toISOString(),
    },
  },
});
