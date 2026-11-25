import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import request from 'supertest';
import prisma from '../../../backend/src/lib/prisma';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';
import {
  EphemeralServerHandle,
  mintAccessToken,
  startEphemeralServer,
} from '../helpers/node/ephemeralServer';

const repoRoot = path.resolve(__dirname, '../../..');

interface NpmAuditMetadata {
  metadata?: {
    vulnerabilities?: {
      info?: number;
      low?: number;
      moderate?: number;
      high?: number;
      critical?: number;
      total?: number;
    };
  };
  error?: { code?: string; summary?: string };
}

function runNpmAuditJson(extraArgs: string[]): NpmAuditMetadata {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const proc = spawnSync(npmCmd, ['audit', '--json', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 45000,
  });

  const cleanStdout = (proc.stdout ?? '').replace(/^\uFEFF/, '').trim();
  if (!cleanStdout) {
    throw new Error(`npm audit produced no JSON output (status=${proc.status}, stderr=${proc.stderr})`);
  }
  const parsed = JSON.parse(cleanStdout) as NpmAuditMetadata;
  if (parsed.error) {
    throw new Error(`npm audit error: ${parsed.error.code} — ${parsed.error.summary}`);
  }
  return parsed;
}

describe('F10 — npm audit Remediation, Deprecated Upgrades & Media Upload (M5)', () => {
  let memPrisma: InMemoryPrisma;
  let server: EphemeralServerHandle | null = null;
  const createdUploadPaths: string[] = [];

  beforeAll(() => {
    memPrisma = new InMemoryPrisma();
    attachInMemoryPrisma(prisma, memPrisma);
  });

  beforeEach(() => {
    memPrisma.reset();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    for (const p of createdUploadPaths.splice(0)) {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
    const tmpDir = path.join(repoRoot, 'uploads', 'tmp');
    if (fs.existsSync(tmpDir)) {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
    }
  });

  it('T1-F10-01: npm audit --omit=dev --json reports 0 critical and 0 high production vulnerabilities', () => {
    const report = runNpmAuditJson(['--omit=dev']);
    const vulns = report.metadata?.vulnerabilities;
    expect(vulns).toBeDefined();
    expect(vulns?.critical).toBe(0);
    expect(vulns?.high).toBe(0);
  }, 60000);

  it('T1-F10-02: backend/package.json upgrades multer to >=2.0.0', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'backend', 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };
    const multerSpec = pkg.dependencies?.multer ?? '';
    const match = multerSpec.match(/(\d+)\./);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
  });

  it('T1-F10-03: backend/package.json removes obsolete @types/ioredis', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'backend', 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.['@types/ioredis']).toBeUndefined();
    expect(pkg.dependencies?.['@types/ioredis']).toBeUndefined();
  });

  it('T1-F10-04: POST /api/media accepts valid PNG multipart upload under upgraded multer', async () => {
    await memPrisma.user.create({
      data: {
        id: 'u-media',
        email: 'media@test.com',
        password: 'hash',
        firstName: 'Media',
        lastName: 'User',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });

    server = await startEphemeralServer();
    const token = mintAccessToken({ id: 'u-media', role: 'CLIENT', tokenVersion: 1 });
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);

    const res = await request(server.app)
      .post('/api/media')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', pngBuffer, { filename: 'pet.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body?.data?.mimeType).toBe('image/png');
    if (typeof res.body?.data?.localPath === 'string') {
      createdUploadPaths.push(res.body.data.localPath);
    }
  });

  it('T1-F10-05: governance check, prisma validate, and workspace manifest scripts remain valid', () => {
    const govScript = path.join(repoRoot, 'scripts', 'verify-governance.js');
    const prismaCli = path.join(repoRoot, 'backend', 'node_modules', 'prisma', 'build', 'index.js');
    const schemaPath = path.join(repoRoot, 'backend', 'prisma', 'schema.prisma');

    execFileSync(process.execPath, [govScript], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync(process.execPath, [prismaCli, 'validate', '--schema', schemaPath], {
      cwd: path.join(repoRoot, 'backend'),
      encoding: 'utf8',
    });

    for (const ws of ['backend', 'web', 'mobile']) {
      const wsPkg = JSON.parse(
        fs.readFileSync(path.join(repoRoot, ws, 'package.json'), 'utf8')
      ) as { scripts?: Record<string, string> };
      expect(typeof wsPkg.scripts?.typecheck).toBe('string');
      expect(typeof wsPkg.scripts?.test).toBe('string');
    }
  });

  it('T2-F10-01: POST /api/media rejects >10 MB file with 413 FILE_TOO_LARGE (never 500)', async () => {
    await memPrisma.user.create({
      data: {
        id: 'u-big',
        email: 'big@test.com',
        password: 'hash',
        firstName: 'Big',
        lastName: 'User',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });

    server = await startEphemeralServer();
    const token = mintAccessToken({ id: 'u-big', role: 'CLIENT', tokenVersion: 1 });
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x89);

    const res = await request(server.app)
      .post('/api/media')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', oversized, { filename: 'huge.png', contentType: 'image/png' });

    expect([400, 413]).toContain(res.status);
    expect(['FILE_TOO_LARGE', 'LIMIT_FILE_SIZE', 'PAYLOAD_TOO_LARGE']).toContain(
      res.body?.error?.code
    );
  });

  it('T2-F10-02: POST /api/media rejects invalid magic bytes with 400 INVALID_FILE_TYPE and 0 DB rows', async () => {
    await memPrisma.user.create({
      data: {
        id: 'u-badmagic',
        email: 'badmagic@test.com',
        password: 'hash',
        firstName: 'Bad',
        lastName: 'Magic',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });

    server = await startEphemeralServer();
    const token = mintAccessToken({ id: 'u-badmagic', role: 'CLIENT', tokenVersion: 1 });
    const fakeExe = Buffer.from('MZ\x90\x00This is not a real JPEG image', 'utf8');

    const res = await request(server.app)
      .post('/api/media')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fakeExe, { filename: 'evil.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_FILE_TYPE');
    expect(await memPrisma.mediaFile.count()).toBe(0);
  });

  it('T2-F10-03: zod schema validation returns 400 VALIDATION_ERROR with structured details', async () => {
    server = await startEphemeralServer();

    const res = await request(server.app)
      .post('/api/auth/register')
      .send({
        email: 'not-an-email',
        password: '123',
        firstName: '',
        lastName: '',
      });

    expect(res.status).toBe(400);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body?.error?.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('T2-F10-04: full monorepo npm audit reports 0 critical vulnerabilities', () => {
    const report = runNpmAuditJson([]);
    const vulns = report.metadata?.vulnerabilities;
    expect(vulns).toBeDefined();
    expect(vulns?.critical).toBe(0);
  }, 60000);

  it('T2-F10-05: cross-workspace React singleton isolation preserves React 18 for web and React 19 for mobile', () => {
    const webReactPkg = require(
      require.resolve('react/package.json', { paths: [path.join(repoRoot, 'web')] })
    ) as { version: string };
    const mobileReactPkg = require(
      require.resolve('react/package.json', { paths: [path.join(repoRoot, 'mobile')] })
    ) as { version: string };

    expect(webReactPkg.version.startsWith('18.')).toBe(true);
    expect(mobileReactPkg.version.startsWith('19.')).toBe(true);

    const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const mobileTsConfig = path.join(repoRoot, 'mobile', 'tsconfig.json');
    execFileSync(process.execPath, [tscBin, '--project', mobileTsConfig, '--noEmit'], {
      cwd: path.join(repoRoot, 'mobile'),
      encoding: 'utf8',
    });
  }, 45000);
});
