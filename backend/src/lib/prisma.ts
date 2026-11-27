import { PrismaClient } from '@prisma/client';
import { buildPooledDatabaseUrl, config } from '../config/env';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prismaDatabaseUrl = buildPooledDatabaseUrl(config.DATABASE_URL);

export function createPrismaClient(databaseUrl: string = prismaDatabaseUrl): PrismaClient {
  return new PrismaClient({
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
    log: config.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient(prismaDatabaseUrl);

if (config.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Returns true when Prisma reports a missing table/column (schema lag vs unmigrated DB).
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 'P2021' || candidate.code === 'P2022') {
    return true;
  }
  if (typeof candidate.message === 'string') {
    const lower = candidate.message.toLowerCase();
    return lower.includes('does not exist') || lower.includes('relation') && lower.includes('exist');
  }
  return false;
}

export default prisma;
