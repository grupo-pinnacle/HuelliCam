import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import pino, { Logger, LoggerOptions } from 'pino';

export interface RequestLogContext {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  socketId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestLogContext>();

const SAFE_CORRELATION_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

export function sanitizeCorrelationId(raw: unknown): string | undefined {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed || !SAFE_CORRELATION_ID_REGEX.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveOrCreateCorrelationId(raw?: unknown): string {
  return sanitizeCorrelationId(raw) ?? crypto.randomUUID();
}

export function runWithLogContext<T>(context: RequestLogContext, fn: () => T): T {
  const existing = requestContextStorage.getStore();
  const merged: RequestLogContext = existing ? { ...existing, ...context } : { ...context };
  return requestContextStorage.run(merged, fn);
}

export function getLogContext(): RequestLogContext | undefined {
  return requestContextStorage.getStore();
}

export function updateLogContext(patch: Partial<RequestLogContext>): void {
  const store = requestContextStorage.getStore();
  if (store) {
    Object.assign(store, patch);
  }
}

const REDACT_PATHS = [
  'password',
  '*.password',
  'newPassword',
  'currentPassword',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'cookie',
  'otp',
  '*.otp',
  'code',
  'codeHash',
  'secret',
  'apiSecret',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'LIVEKIT_API_SECRET',
];

function resolveLogLevel(): string {
  const explicit = process.env.LOG_LEVEL?.trim();
  if (explicit) {
    return explicit;
  }
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

const baseLoggerOptions: LoggerOptions = {
  level: resolveLogLevel(),
  base: {
    service: 'huellicam-backend',
    env: process.env.NODE_ENV || 'development',
  },
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  mixin() {
    const store = requestContextStorage.getStore();
    if (!store) {
      return {};
    }
    const ctx: Record<string, string> = {};
    if (store.requestId) ctx.requestId = store.requestId;
    if (store.correlationId) ctx.correlationId = store.correlationId;
    if (store.userId) ctx.userId = store.userId;
    if (store.socketId) ctx.socketId = store.socketId;
    return ctx;
  },
};

export const logger: Logger = pino(
  baseLoggerOptions,
  pino.destination({
    fd: 1,
    sync: process.env.NODE_ENV === 'test',
  })
);

export const stderrLogger: Logger = pino(
  {
    ...baseLoggerOptions,
    level: process.env.LOG_LEVEL?.trim() || 'error',
  },
  pino.destination({
    fd: 2,
    sync: true,
  })
);

export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const extra = err as Error & { code?: unknown; statusCode?: unknown };
    return {
      name: err.name,
      message: err.message,
      ...(extra.code !== undefined ? { code: extra.code } : {}),
      ...(extra.statusCode !== undefined ? { statusCode: extra.statusCode } : {}),
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err) };
}

export default logger;
