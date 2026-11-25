import prisma, { createPrismaClient, prismaDatabaseUrl } from '../lib/prisma';
import {
  buildPooledDatabaseUrl,
  DEFAULT_DB_POOL_LIMIT,
  DEFAULT_DB_POOL_TIMEOUT,
} from '../config/env';

describe('Prisma Singleton Client', () => {
  it('should instantiate PrismaClient singleton instance', () => {
    expect(prisma).toBeDefined();
    expect(typeof prisma.$connect).toBe('function');
    expect(typeof prisma.$disconnect).toBe('function');
  });

  it('should configure pooled datasource URL for PgBouncer transaction mode', () => {
    const parsed = new URL(prismaDatabaseUrl);
    expect(parsed.searchParams.get('pgbouncer')).toBe('true');
    expect(parsed.searchParams.get('connection_limit')).toBe(String(DEFAULT_DB_POOL_LIMIT));
    expect(parsed.searchParams.get('pool_timeout')).toBe(String(DEFAULT_DB_POOL_TIMEOUT));
    expect(parsed.searchParams.get('statement_cache_size')).toBe('0');
    expect(typeof createPrismaClient).toBe('function');
  });

  it('should have all 10 canonical v2.0 models defined on client instance', () => {
    expect(prisma.user).toBeDefined();
    expect(prisma.pet).toBeDefined();
    expect(prisma.consultation).toBeDefined();
    expect(prisma.message).toBeDefined();
    expect(prisma.call).toBeDefined();
    expect(prisma.prescription).toBeDefined();
    expect(prisma.review).toBeDefined();
    expect(prisma.auditLog).toBeDefined();
    expect(prisma.dailyUploadCounter).toBeDefined();
    expect(prisma.mediaFile).toBeDefined();
  });

  it('should have support models defined on client instance', () => {
    expect(prisma.pushToken).toBeDefined();
    expect(prisma.notification).toBeDefined();
  });

  describe('buildPooledDatabaseUrl', () => {
    it('appends PgBouncer and pool defaults while preserving existing query params', () => {
      const result = buildPooledDatabaseUrl(
        'postgresql://user:pass@pooler.supabase.com:6543/postgres?schema=public&sslmode=require'
      );
      const parsed = new URL(result);
      expect(parsed.searchParams.get('schema')).toBe('public');
      expect(parsed.searchParams.get('sslmode')).toBe('require');
      expect(parsed.searchParams.get('pgbouncer')).toBe('true');
      expect(parsed.searchParams.get('connection_limit')).toBe('20');
      expect(parsed.searchParams.get('pool_timeout')).toBe('15');
      expect(parsed.searchParams.get('statement_cache_size')).toBe('0');
    });

    it('preserves explicit URL query params when no overriding options are provided', () => {
      const result = buildPooledDatabaseUrl(
        'postgres://user:pass@db.host:5432/app?connection_limit=7&pool_timeout=25&pgbouncer=false'
      );
      const parsed = new URL(result);
      expect(parsed.searchParams.get('pgbouncer')).toBe('false');
      expect(parsed.searchParams.get('connection_limit')).toBe('7');
      expect(parsed.searchParams.get('pool_timeout')).toBe('25');
      expect(parsed.searchParams.has('statement_cache_size')).toBe(false);
    });

    it('overrides connection_limit and pool_timeout when explicit options are provided', () => {
      const result = buildPooledDatabaseUrl(
        'postgresql://user:pass@db.host:5432/app?connection_limit=5&pool_timeout=10',
        { connectionLimit: 32, poolTimeout: 45 }
      );
      const parsed = new URL(result);
      expect(parsed.searchParams.get('connection_limit')).toBe('32');
      expect(parsed.searchParams.get('pool_timeout')).toBe('45');
      expect(parsed.searchParams.get('pgbouncer')).toBe('true');
      expect(parsed.searchParams.get('statement_cache_size')).toBe('0');
    });

    it('is idempotent when called repeatedly', () => {
      const once = buildPooledDatabaseUrl('postgresql://user:pass@db.host:5432/app');
      const twice = buildPooledDatabaseUrl(once);
      expect(twice).toBe(once);
    });

    it('sanitizes invalid connection_limit and pool_timeout query params and handles case-insensitive pgbouncer', () => {
      const sanitized = buildPooledDatabaseUrl(
        'postgresql://user:pass@db.host:5432/app?connection_limit=0&pool_timeout=-1&pgbouncer=TRUE'
      );
      const parsed = new URL(sanitized);
      expect(parsed.searchParams.get('connection_limit')).toBe(String(DEFAULT_DB_POOL_LIMIT));
      expect(parsed.searchParams.get('pool_timeout')).toBe(String(DEFAULT_DB_POOL_TIMEOUT));
      expect(parsed.searchParams.get('pgbouncer')).toBe('TRUE');
      expect(parsed.searchParams.get('statement_cache_size')).toBe('0');

      const nonInteger = buildPooledDatabaseUrl(
        'postgresql://user:pass@db.host:5432/app?connection_limit=abc&pool_timeout=1.5'
      );
      const parsedNonInt = new URL(nonInteger);
      expect(parsedNonInt.searchParams.get('connection_limit')).toBe(String(DEFAULT_DB_POOL_LIMIT));
      expect(parsedNonInt.searchParams.get('pool_timeout')).toBe(String(DEFAULT_DB_POOL_TIMEOUT));
    });

    it('returns non-Postgres URLs and invalid URLs unchanged without throwing', () => {
      expect(buildPooledDatabaseUrl('file:./test.db')).toBe('file:./test.db');
      expect(buildPooledDatabaseUrl('prisma://accelerate.prisma-data.net/?api_key=x')).toBe(
        'prisma://accelerate.prisma-data.net/?api_key=x'
      );
      expect(buildPooledDatabaseUrl('not-a-valid-url')).toBe('not-a-valid-url');
      expect(buildPooledDatabaseUrl('   ')).toBe('');
    });
  });
});
