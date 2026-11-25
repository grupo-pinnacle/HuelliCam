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

export default prisma;
