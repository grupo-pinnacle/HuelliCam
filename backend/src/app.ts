import './config/env';
import express, { Express, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import prisma from './lib/prisma';
import { errorHandler } from './middlewares/errorHandler';
import { requestIdMiddleware } from './middlewares/requestId';
import { isAllowedOrigin } from './config/cors';
import authRoutes from './modules/auth/auth.routes';
import petRoutes from './modules/pets/pets.routes';
import consultationRoutes from './modules/consultations/consultations.routes';
import prescriptionRoutes from './modules/prescriptions/prescriptions.routes';
import callRoutes from './modules/calls/calls.routes';
import mediaRoutes from './modules/media/media.routes';
import notificationRoutes from './modules/notifications/notifications.routes';
import adminRoutes from './modules/admin/admin.routes';
import userRoutes from './modules/users/users.routes';

const app: Express = express();

// Trust reverse proxy (Coolify, Nginx, Traefik, Vercel, ALB) for secure cookies and accurate IPs
app.set('trust proxy', 1);

// Request / Correlation ID tracing must run first (including CORS preflight, 413, and webhooks)
app.use(requestIdMiddleware);

// Middlewares
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'ws:', '*.livekit.cloud', 'https://*.livekit.cloud'],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
      },
    },
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Client-Platform',
      'X-Device-Id',
      'x-device-id',
      'X-Request-Id',
      'x-request-id',
      'X-Correlation-Id',
      'x-correlation-id',
      'sentry-trace',
      'baggage',
    ],
  })
);

// Preserve raw bytes for LiveKit HMAC SHA256 webhook verification before express.json()
app.use('/api/calls/webhook', express.raw({ type: '*/*', limit: '100kb' }));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

// Rate limiters for sensitive auth endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiados intentos de inicio de sesion. Reintente en 15 minutos.',
      timestamp: new Date().toISOString(),
    },
  },
  skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development',
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Demasiados registros desde esta IP. Reintente en 15 minutos.',
      timestamp: new Date().toISOString(),
    },
  },
  skip: () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development',
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/pets', petRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api', prescriptionRoutes);

// Health Check Endpoint
app.get('/health', async (req: Request, res: Response) => {
  let dbStatus = 'disconnected';
  try {
    if (process.env.NODE_ENV === 'test') {
      dbStatus = 'connected';
    } else {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = 'connected';
    }
  } catch (error) {
    dbStatus = 'error';
  }

  const isHealthy = dbStatus === 'connected';
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.env.NODE_ENV === 'test' ? 100 : process.uptime(),
    database: dbStatus,
  });
});

// Centralized Error Handler Middleware
app.use(errorHandler);

export default app;
