import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import prisma from '../../../backend/src/lib/prisma';
import { buildPooledDatabaseUrl } from '../../../backend/src/config/env';
import {
  consultationConcurrencyService,
  setConcurrencySchemaSupportForTest,
} from '../../../backend/src/modules/consultations/consultationConcurrency.service';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';

const repoRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(repoRoot, 'backend', 'prisma', 'schema.prisma');
const backendDir = path.join(repoRoot, 'backend');

describe('F01 — PostgreSQL Pool Sizing, PgBouncer Config & Optimistic CAS (M1)', () => {
  let memPrisma: InMemoryPrisma;

  beforeAll(() => {
    memPrisma = new InMemoryPrisma();
    attachInMemoryPrisma(prisma, memPrisma);
  });

  beforeEach(() => {
    memPrisma.reset();
    setConcurrencySchemaSupportForTest(true);
  });

  function assertNoForUpdateSql(): void {
    const forUpdateQueries = memPrisma.capturedSql.filter((entry) =>
      /\bFOR\s+UPDATE\b/i.test(entry.sql)
    );
    expect(forUpdateQueries).toEqual([]);
  }

  it('T1-F01-01: schema.prisma declares directUrl = env("DIRECT_URL") and passes prisma validate', () => {
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    expect(schemaContent).toMatch(/url\s*=\s*env\("DATABASE_URL"\)/);
    expect(schemaContent).toMatch(/directUrl\s*=\s*env\("DIRECT_URL"\)/);

    const prismaCli = path.join(repoRoot, 'backend', 'node_modules', 'prisma', 'build', 'index.js');
    const output = execFileSync(
      process.execPath,
      [prismaCli, 'validate', '--schema', schemaPath],
      { cwd: backendDir, encoding: 'utf8', env: process.env }
    );
    expect(output).toMatch(/is valid/i);
  });

  it('T1-F01-02: buildPooledDatabaseUrl appends pgbouncer=true and default connection_limit=20', () => {
    const raw = 'postgresql://user:pass@pooler.supabase.com:6543/postgres';
    const pooled = buildPooledDatabaseUrl(raw);
    const parsed = new URL(pooled);

    expect(parsed.hostname).toBe('pooler.supabase.com');
    expect(parsed.port).toBe('6543');
    expect(parsed.pathname).toBe('/postgres');
    expect(parsed.searchParams.get('pgbouncer')).toBe('true');
    expect(parsed.searchParams.get('connection_limit')).toBe('20');
  });

  it('T1-F01-03: buildPooledDatabaseUrl preserves existing params and applies explicit connectionLimit=35', () => {
    const raw = 'postgresql://u:p@host:6543/db?sslmode=require';
    const pooled = buildPooledDatabaseUrl(raw, { connectionLimit: 35 });
    const parsed = new URL(pooled);

    expect(pooled.split('?').length).toBe(2);
    expect(parsed.searchParams.get('sslmode')).toBe('require');
    expect(parsed.searchParams.get('pgbouncer')).toBe('true');
    expect(parsed.searchParams.get('connection_limit')).toBe('35');
  });

  it('T1-F01-04: claimConsultationByVet updates stateVersion via CAS with 0 FOR UPDATE queries', async () => {
    await memPrisma.user.create({
      data: {
        id: 'tutor-1',
        email: 'tutor1@test.com',
        password: 'hash',
        firstName: 'Tutor',
        lastName: 'One',
        role: 'CLIENT',
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'vet-1',
        email: 'vet1@test.com',
        password: 'hash',
        firstName: 'Vet',
        lastName: 'One',
        role: 'VET',
        vetStatus: 'APPROVED',
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'cons-1',
        clientId: 'tutor-1',
        petId: 'pet-1',
        status: 'WAITING',
        transportStatus: 'ONLINE',
        stateVersion: 1,
      },
    });

    const result = await consultationConcurrencyService.claimConsultationByVet('cons-1', 'vet-1');

    expect(result.consultationId).toBe('cons-1');
    expect(['LIVEKIT_CONNECTING', 'IN_CALL_ACTIVE', 'ACTIVE', 'CLAIM_PENDING_SYNC']).toContain(
      result.status
    );
    expect(result.stateVersion).toBe(2);
    assertNoForUpdateSql();
  });

  it('T1-F01-05: migrateTutorSession updates activeDeviceId via CAS with 0 FOR UPDATE queries', async () => {
    await memPrisma.consultation.create({
      data: {
        id: 'cons-2',
        clientId: 'tutor-2',
        petId: 'pet-2',
        status: 'IN_CALL_ACTIVE',
        vetId: 'vet-1',
        activeDeviceId: 'dev-old',
        transportStatus: 'ONLINE',
        stateVersion: 3,
      },
    });

    const result = await consultationConcurrencyService.migrateTutorSession('tutor-2', 'dev-new');

    expect(result.hasActiveConsultation).toBe(true);
    expect(result.revokedDeviceId).toBe('dev-old');
    expect(result.stateVersion).toBe(4);
    assertNoForUpdateSql();
  });

  it('T2-F01-01: buildPooledDatabaseUrl does not duplicate params and leaves DIRECT_URL untouched', () => {
    const raw =
      'postgresql://user:pass@pooler.supabase.com:6543/postgres?schema=public&pgbouncer=true&connection_limit=50';
    const pooled = buildPooledDatabaseUrl(raw);
    const parsed = new URL(pooled);

    expect(parsed.searchParams.getAll('pgbouncer')).toEqual(['true']);
    expect(parsed.searchParams.get('schema')).toBe('public');
    expect(parsed.searchParams.get('connection_limit')).toBe('50');

    const directUrl = process.env.DIRECT_URL ?? '';
    expect(directUrl).not.toContain('pgbouncer=true');
  });

  it('T2-F01-02: concurrent claimConsultationByVet race succeeds once and rejects conflict with 0 FOR UPDATE queries', async () => {
    await memPrisma.consultation.create({
      data: {
        id: 'cons-race',
        clientId: 'tutor-race',
        petId: 'pet-race',
        status: 'WAITING',
        transportStatus: 'ONLINE',
        stateVersion: 1,
      },
    });

    const outcomes = await Promise.allSettled([
      consultationConcurrencyService.claimConsultationByVet('cons-race', 'vet-A'),
      consultationConcurrencyService.claimConsultationByVet('cons-race', 'vet-B'),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (fulfilled[0].status === 'fulfilled') {
      expect(fulfilled[0].value.stateVersion).toBe(2);
    }
    if (rejected[0].status === 'rejected') {
      const err = rejected[0].reason as { statusCode?: number; code?: string };
      expect(err.statusCode).toBe(409);
    }
    const persisted = await memPrisma.consultation.findUnique({ where: { id: 'cons-race' } });
    expect(persisted).not.toBeNull();
    expect(persisted?.stateVersion).toBe(2);
    expect(['vet-A', 'vet-B']).toContain(persisted?.vetId);
    assertNoForUpdateSql();
  });

  it('T2-F01-03: claimConsultationByVet rejects COMPLETED or CANCELLED consultations without mutating version', async () => {
    await memPrisma.consultation.create({
      data: {
        id: 'cons-completed',
        clientId: 'tutor-3',
        petId: 'pet-3',
        status: 'COMPLETED',
        stateVersion: 7,
      },
    });

    await expect(
      consultationConcurrencyService.claimConsultationByVet('cons-completed', 'vet-A')
    ).rejects.toMatchObject({
      statusCode: expect.any(Number),
    });

    const unchanged = await memPrisma.consultation.findUnique({ where: { id: 'cons-completed' } });
    expect(unchanged?.stateVersion).toBe(7);
    expect(unchanged?.vetId).toBeNull();
  });

  it('T2-F01-04: migrateTutorSession rejects stale version conflict cleanly without FOR UPDATE', async () => {
    await memPrisma.consultation.create({
      data: {
        id: 'cons-stale',
        clientId: 'tutor-stale',
        petId: 'pet-stale',
        status: 'WAITING',
        activeDeviceId: 'dev-1',
        stateVersion: 5,
      },
    });

    const origUpdateMany = memPrisma.consultation.updateMany;
    memPrisma.consultation.updateMany = async () => ({ count: 0 });
    try {
      let conflictDetected = false;
      try {
        const res = (await consultationConcurrencyService.migrateTutorSession(
          'tutor-stale',
          'dev-new'
        )) as unknown as { ok?: boolean; reason?: string; hasActiveConsultation?: boolean };
        if (res && res.ok === false && res.reason === 'CONFLICT') {
          conflictDetected = true;
        }
      } catch (err) {
        const appErr = err as { statusCode?: number };
        if (appErr.statusCode === 409) {
          conflictDetected = true;
        }
      }
      expect(conflictDetected).toBe(true);
    } finally {
      memPrisma.consultation.updateMany = origUpdateMany;
    }

    const after = await memPrisma.consultation.findUnique({ where: { id: 'cons-stale' } });
    expect(after?.activeDeviceId).toBe('dev-1');
    expect(after?.stateVersion).toBe(5);
    assertNoForUpdateSql();
  });

  it('T2-F01-05: buildPooledDatabaseUrl rejects/clamps invalid pool limits (0, -5, NaN)', () => {
    const base = 'postgresql://user:pass@host:6543/postgres';
    for (const invalidLimit of [0, -5, Number.NaN]) {
      const result = buildPooledDatabaseUrl(base, { connectionLimit: invalidLimit });
      const parsed = new URL(result);
      const limit = Number(parsed.searchParams.get('connection_limit'));
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      expect(result).not.toContain('connection_limit=NaN');
      expect(result).not.toContain('connection_limit=0');
      expect(result).not.toContain('connection_limit=-5');
    }
  });
});
