import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { isValidRedisUrl, normalizeRedisUrl } from '../lib/redis';
import { stderrLogger } from '../lib/logger';

// Cargar .env desde múltiples rutas candidatas (raíz del monorepo, backend/ o cwd)
const rootEnvPath = path.resolve(__dirname, '..', '..', '..', '.env');
const backendEnvPath = path.resolve(__dirname, '..', '..', '.env');

const candidatePaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'backend', '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  rootEnvPath,
  backendEnvPath,
  path.resolve(__dirname, '..', '.env'),
];

for (const p of candidatePaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: false });
  }
}

// Si existe .env en la raíz pero no en backend/, creamos una copia local para que Prisma CLI funcione sin fallos
try {
  if (fs.existsSync(rootEnvPath) && !fs.existsSync(backendEnvPath)) {
    fs.copyFileSync(rootEnvPath, backendEnvPath);
  }
} catch {
  // Ignorar errores de filesystem en entornos restringidos
}

export const DEFAULT_DB_POOL_LIMIT = 20;
export const DEFAULT_DB_POOL_TIMEOUT = 15;
export const DEFAULT_DISCONNECT_DEBOUNCE_MS = 5000;

export interface PooledDatabaseUrlOptions {
  connectionLimit?: number;
  poolTimeout?: number;
  pgbouncer?: boolean;
  statementCacheSize?: number;
}

function parsePositiveIntString(val: string | null | undefined): number | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const num = Number(trimmed);
  return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

function stripPooledParamsFromUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const parsedUrl = new URL(trimmed);
    if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
      return trimmed;
    }
    parsedUrl.searchParams.delete('pgbouncer');
    parsedUrl.searchParams.delete('statement_cache_size');
    return parsedUrl.toString();
  } catch {
    return trimmed;
  }
}

export function buildPooledDatabaseUrl(
  rawUrl: string,
  options: PooledDatabaseUrlOptions = {}
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
    return trimmed;
  }

  if (options.pgbouncer !== undefined) {
    parsedUrl.searchParams.set('pgbouncer', String(options.pgbouncer));
  } else if (!parsedUrl.searchParams.has('pgbouncer')) {
    parsedUrl.searchParams.set('pgbouncer', 'true');
  }

  const validLimit =
    options.connectionLimit !== undefined &&
    Number.isInteger(options.connectionLimit) &&
    options.connectionLimit > 0
      ? options.connectionLimit
      : undefined;
  const existingLimit = parsePositiveIntString(parsedUrl.searchParams.get('connection_limit'));
  if (validLimit !== undefined) {
    parsedUrl.searchParams.set('connection_limit', String(validLimit));
  } else if (existingLimit === undefined) {
    parsedUrl.searchParams.set('connection_limit', String(DEFAULT_DB_POOL_LIMIT));
  }

  const validTimeout =
    options.poolTimeout !== undefined &&
    Number.isInteger(options.poolTimeout) &&
    options.poolTimeout > 0
      ? options.poolTimeout
      : undefined;
  const existingTimeout = parsePositiveIntString(parsedUrl.searchParams.get('pool_timeout'));
  if (validTimeout !== undefined) {
    parsedUrl.searchParams.set('pool_timeout', String(validTimeout));
  } else if (existingTimeout === undefined) {
    parsedUrl.searchParams.set('pool_timeout', String(DEFAULT_DB_POOL_TIMEOUT));
  }

  const isPgBouncerEnabled =
    (parsedUrl.searchParams.get('pgbouncer') ?? '').trim().toLowerCase() === 'true';
  if (isPgBouncerEnabled) {
    const validCacheSize =
      options.statementCacheSize !== undefined &&
      Number.isInteger(options.statementCacheSize) &&
      options.statementCacheSize >= 0
        ? options.statementCacheSize
        : undefined;
    if (validCacheSize !== undefined) {
      parsedUrl.searchParams.set('statement_cache_size', String(validCacheSize));
    } else if (!parsedUrl.searchParams.has('statement_cache_size')) {
      parsedUrl.searchParams.set('statement_cache_size', '0');
    }
  }

  return parsedUrl.toString();
}

function parsePositiveIntFromQuery(urlStr: string, param: string): number | undefined {
  try {
    const parsedUrl = new URL(urlStr);
    return parsePositiveIntString(parsedUrl.searchParams.get(param));
  } catch {
    return undefined;
  }
}

// Normalización de alias comunes para la URL de base de datos (Supabase, Neon, Vercel, o 'base_url')
const rawDbUrl =
  process.env.DATABASE_URL ||
  process.env.database_url ||
  process.env.BASE_URL ||
  process.env.base_url ||
  process.env.SUPABASE_DATABASE_URL ||
  process.env.SUPABASE_DB_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRESQL_URL ||
  (process.env.SUPABASE_URL?.startsWith('postgres') ? process.env.SUPABASE_URL : undefined);

if (rawDbUrl) {
  // Limpiar posibles comillas dobles o simples accidentales y espacios
  process.env.DATABASE_URL = rawDbUrl.trim().replace(/^["']|["']$/g, '');
}

if (process.env.DIRECT_URL) {
  process.env.DIRECT_URL = process.env.DIRECT_URL.trim().replace(/^["']|["']$/g, '');
}

// Fallback amigable para desarrollo local si aún no está definida
if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'production') {
  process.env.DATABASE_URL =
    'postgresql://postgres:postgrespassword@localhost:5432/huellicam_dev?schema=public';
}

// Garantizar DIRECT_URL (sin parámetros PgBouncer) antes de aplicar pooling sobre DATABASE_URL
if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = stripPooledParamsFromUrl(process.env.DATABASE_URL);
}

// Normalización de alias comunes para JWT y Storage (compatibilidad histórica y de templates)
if (!process.env.JWT_REFRESH_SECRET && process.env.REFRESH_TOKEN_SECRET) {
  process.env.JWT_REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET;
}
if (!process.env.REFRESH_TOKEN_SECRET && process.env.JWT_REFRESH_SECRET) {
  process.env.REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET;
}

if (!process.env.STORAGE_DRIVER && process.env.STORAGE_PROVIDER) {
  process.env.STORAGE_DRIVER = process.env.STORAGE_PROVIDER;
}
if (!process.env.STORAGE_PROVIDER && process.env.STORAGE_DRIVER) {
  process.env.STORAGE_PROVIDER = process.env.STORAGE_DRIVER;
}

if (!process.env.AWS_BUCKET_NAME && process.env.AWS_S3_BUCKET_NAME) {
  process.env.AWS_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
}
if (!process.env.AWS_S3_BUCKET_NAME && process.env.AWS_BUCKET_NAME) {
  process.env.AWS_S3_BUCKET_NAME = process.env.AWS_BUCKET_NAME;
}

if (!process.env.FRONTEND_URL && process.env.CLIENT_URL) {
  process.env.FRONTEND_URL = process.env.CLIENT_URL;
}

const normalizedRedisEnv = normalizeRedisUrl(process.env.REDIS_URL);
if (normalizedRedisEnv !== undefined) {
  process.env.REDIS_URL = normalizedRedisEnv;
} else if (Object.prototype.hasOwnProperty.call(process.env, 'REDIS_URL')) {
  process.env.REDIS_URL = '';
}

const optionalPositiveInt = (max: number) =>
  z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.coerce.number().int().min(1).max(max).optional()
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().default('3001').transform((val) => parseInt(val, 10)),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL es requerida'),
    DIRECT_URL: z.string().optional(),
    DB_POOL_LIMIT: optionalPositiveInt(200),
    DATABASE_CONNECTION_LIMIT: optionalPositiveInt(200),
    DB_POOL_TIMEOUT: optionalPositiveInt(120),
    DISCONNECT_DEBOUNCE_MS: z
      .string()
      .optional()
      .default(String(DEFAULT_DISCONNECT_DEBOUNCE_MS))
      .transform((val) => {
        const parsed = Number.parseInt(val, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DISCONNECT_DEBOUNCE_MS;
      }),
    JWT_SECRET: z
      .string()
      .min(32, 'JWT_SECRET debe tener al menos 32 caracteres para seguridad criptográfica'),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET debe tener al menos 32 caracteres'),
    REDIS_URL: z.preprocess(
      (val) => (typeof val === 'string' ? normalizeRedisUrl(val) : undefined),
      z.string().refine(isValidRedisUrl, 'REDIS_URL debe comenzar con redis:// o rediss://').optional()
    ),
    LIVEKIT_URL: z.string().min(1, 'LIVEKIT_URL es requerido'),
    LIVEKIT_API_KEY: z.string().min(1, 'LIVEKIT_API_KEY es requerido'),
    LIVEKIT_API_SECRET: z.string().min(1, 'LIVEKIT_API_SECRET es requerido'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().default('./uploads'),
    AWS_ACCESS_KEY_ID: z.string().optional().default(''),
    AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),
    AWS_REGION: z.string().default('us-east-1'),
    AWS_BUCKET_NAME: z.string().default('huellicam-media'),
    CORS_ORIGIN: z.string().optional(),
    FRONTEND_URL: z.string().optional(),
    CLIENT_URL: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Huellicam <onboarding@resend.dev>'),
    ENABLE_EMAIL_SCHEDULER: z.enum(['true', 'false']).optional(),
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().default('mailto:soporte@huellicam.com.ar'),
    SENTRY_DSN: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production' && !data.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL es requerida en producción',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  stderrLogger.fatal(
    { fieldErrors: parsed.error.flatten().fieldErrors },
    'Error crítico: Validación de variables de entorno fallida'
  );
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
}

const resolvedConfig = (() => {
  if (parsed.success) {
    const explicitPoolLimit = parsed.data.DB_POOL_LIMIT ?? parsed.data.DATABASE_CONNECTION_LIMIT;
    const pooledDatabaseUrl = buildPooledDatabaseUrl(parsed.data.DATABASE_URL, {
      connectionLimit: explicitPoolLimit,
      poolTimeout: parsed.data.DB_POOL_TIMEOUT,
    });
    process.env.DATABASE_URL = pooledDatabaseUrl;

    const effectivePoolLimit =
      explicitPoolLimit ??
      parsePositiveIntFromQuery(pooledDatabaseUrl, 'connection_limit') ??
      DEFAULT_DB_POOL_LIMIT;
    const effectivePoolTimeout =
      parsed.data.DB_POOL_TIMEOUT ??
      parsePositiveIntFromQuery(pooledDatabaseUrl, 'pool_timeout') ??
      DEFAULT_DB_POOL_TIMEOUT;

    return {
      ...parsed.data,
      DATABASE_URL: pooledDatabaseUrl,
      DB_POOL_LIMIT: effectivePoolLimit,
      DB_POOL_TIMEOUT: effectivePoolTimeout,
    };
  }

  const parseBoundedPositiveInt = (val: string | undefined, max: number): number | undefined => {
    const parsedInt = parsePositiveIntString(val);
    return parsedInt !== undefined && parsedInt <= max ? parsedInt : undefined;
  };
  const fallbackDbPoolLimit = parseBoundedPositiveInt(process.env.DB_POOL_LIMIT, 200);
  const fallbackConnectionLimit = parseBoundedPositiveInt(
    process.env.DATABASE_CONNECTION_LIMIT,
    200
  );
  const fallbackExplicitPoolLimit = fallbackDbPoolLimit ?? fallbackConnectionLimit;
  const fallbackExplicitPoolTimeout = parseBoundedPositiveInt(process.env.DB_POOL_TIMEOUT, 120);

  const fallbackDatabaseUrl = buildPooledDatabaseUrl(process.env.DATABASE_URL || 'file:./test.db', {
    connectionLimit: fallbackExplicitPoolLimit,
    poolTimeout: fallbackExplicitPoolTimeout,
  });
  if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = fallbackDatabaseUrl;
  }
  const fallbackDebounce = Number.parseInt(process.env.DISCONNECT_DEBOUNCE_MS ?? '', 10);

  return {
    NODE_ENV: 'test' as const,
    PORT: 3001,
    DATABASE_URL: fallbackDatabaseUrl,
    DIRECT_URL: process.env.DIRECT_URL,
    DB_POOL_LIMIT:
      fallbackExplicitPoolLimit ??
      parsePositiveIntFromQuery(fallbackDatabaseUrl, 'connection_limit') ??
      DEFAULT_DB_POOL_LIMIT,
    DATABASE_CONNECTION_LIMIT: fallbackConnectionLimit,
    DB_POOL_TIMEOUT:
      fallbackExplicitPoolTimeout ??
      parsePositiveIntFromQuery(fallbackDatabaseUrl, 'pool_timeout') ??
      DEFAULT_DB_POOL_TIMEOUT,
    DISCONNECT_DEBOUNCE_MS:
      Number.isFinite(fallbackDebounce) && fallbackDebounce >= 0
        ? fallbackDebounce
        : DEFAULT_DISCONNECT_DEBOUNCE_MS,
    JWT_SECRET:
      process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long',
    JWT_REFRESH_SECRET:
      process.env.JWT_REFRESH_SECRET ||
      process.env.REFRESH_TOKEN_SECRET ||
      'dev-refresh-secret-key-change-in-production-min-32-chars-long',
    REDIS_URL: (() => {
      const normalized = normalizeRedisUrl(process.env.REDIS_URL);
      return normalized && isValidRedisUrl(normalized) ? normalized : undefined;
    })(),
    LIVEKIT_URL: 'wss://huellicam-dev.livekit.cloud',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    STORAGE_DRIVER: (process.env.STORAGE_DRIVER as 'local' | 's3') || 'local',
    UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM || 'Huellicam <onboarding@resend.dev>',
    ENABLE_EMAIL_SCHEDULER: process.env.ENABLE_EMAIL_SCHEDULER as 'true' | 'false' | undefined,
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:soporte@huellicam.com.ar',
    SENTRY_DSN: process.env.SENTRY_DSN,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    AWS_BUCKET_NAME:
      process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || 'huellicam-media',
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    FRONTEND_URL: process.env.FRONTEND_URL || process.env.CLIENT_URL,
    CLIENT_URL: process.env.CLIENT_URL,
  };
})();

export const config = Object.freeze(resolvedConfig);

export type Config = typeof config;
