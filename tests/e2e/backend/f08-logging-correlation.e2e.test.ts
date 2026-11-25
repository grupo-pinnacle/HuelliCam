import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import prisma from '../../../backend/src/lib/prisma';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';
import {
  EphemeralServerHandle,
  mintAccessToken,
  startEphemeralServer,
} from '../helpers/node/ephemeralServer';
import { runTsxSnippet } from '../helpers/node/subprocess';

const repoRoot = path.resolve(__dirname, '../../..');
const loggerPath = path.join(repoRoot, 'backend', 'src', 'lib', 'logger.ts');
const backendSrcDir = path.join(repoRoot, 'backend', 'src');

function collectProdTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      results.push(...collectProdTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function stripTsComments(source: string): string {
  return source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (match) => {
      if (match.startsWith('//') || match.startsWith('/*')) {
        return match.replace(/[^\r\n]/g, ' ');
      }
      return match;
    }
  );
}

describe('F08 — Structured JSON Logging (pino) & Correlation IDs (M4)', () => {
  let memPrisma: InMemoryPrisma;
  let server: EphemeralServerHandle | null = null;

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
  });

  it('T1-F08-01: backend/src/lib/logger.ts emits valid single-line JSON via pino stdout', () => {
    expect(fs.existsSync(loggerPath)).toBe(true);

    const res = runTsxSnippet(
      `
      import * as loggerMod from './backend/src/lib/logger';
      const logger = (loggerMod as any).default ?? (loggerMod as any).logger;
      if (!logger || typeof logger.info !== 'function') process.exit(2);
      logger.info({ requestId: 'req-123' }, 'Consultation assigned');
      `,
      { NODE_ENV: 'production', LOG_LEVEL: 'info' }
    );

    expect(res.status).toBe(0);
    const match = res.parsedJsonLines.find(
      (entry) => entry.msg === 'Consultation assigned' && entry.requestId === 'req-123'
    );
    expect(match).toBeDefined();
    expect(typeof match?.level).toBe('number');
    expect(match?.time).toBeDefined();
  });

  it('T1-F08-02: HTTP request echoes X-Request-Id and logs JSON line with matching requestId', async () => {
    server = await startEphemeralServer();

    const res = await request(server.app)
      .get('/health')
      .set('X-Request-Id', 'req-abc-123');

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-abc-123');

    const subRes = runTsxSnippet(
      `
      import request from 'supertest';
      import app from './backend/src/app';
      request(app)
        .get('/health')
        .set('X-Request-Id', 'req-abc-123')
        .then((r) => {
          if (r.headers['x-request-id'] !== 'req-abc-123') process.exit(2);
          process.exit(0);
        });
      `,
      { NODE_ENV: 'test', LOG_LEVEL: 'info' }
    );
    expect(subRes.status).toBe(0);
    const hasLogWithReqId = subRes.parsedJsonLines.some(
      (line) =>
        (line.requestId ?? line.correlationId ?? (line.req as { id?: string } | undefined)?.id) ===
        'req-abc-123'
    );
    expect(hasLogWithReqId).toBe(true);
  });

  it('T1-F08-03: HTTP request without X-Request-Id generates ID and embeds matching error.requestId', async () => {
    await memPrisma.user.create({
      data: {
        id: 'cli-f08',
        email: 'cli-f08@test.com',
        password: 'hash',
        firstName: 'Cli',
        lastName: 'F08',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    server = await startEphemeralServer();
    const token = mintAccessToken({ id: 'cli-f08', role: 'CLIENT', tokenVersion: 1 });

    const res = await request(server.app)
      .post('/api/consultations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', '10.8.0.1')
      .send({ petId: '', notes: '' });

    expect(res.status).toBe(400);
    const headerReqId = res.headers['x-request-id'];
    expect(typeof headerReqId).toBe('string');
    expect(headerReqId.length).toBeGreaterThan(0);
    expect(res.body?.error?.requestId).toBe(headerReqId);
  });

  it('T1-F08-04: Socket.io handshake correlationId is attached to socket.data and logged in JSON', async () => {
    expect(fs.existsSync(loggerPath)).toBe(true);

    await memPrisma.user.create({
      data: {
        id: 'cli-ws-f08',
        email: 'cli-ws-f08@test.com',
        password: 'hash',
        firstName: 'Cli',
        lastName: 'WS',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });

    server = await startEphemeralServer();
    let capturedCorrelationId: string | undefined;
    server.io.on('connection', (sock) => {
      capturedCorrelationId = (sock.data as { correlationId?: string }).correlationId;
    });

    const token = mintAccessToken({ id: 'cli-ws-f08', role: 'CLIENT', tokenVersion: 1 });
    await server.connectSocket({ token, correlationId: 'corr-ws-99' });

    expect(capturedCorrelationId).toBe('corr-ws-99');

    const logRes = runTsxSnippet(
      `
      import { createServer } from 'http';
      import { AddressInfo } from 'net';
      import jwt from 'jsonwebtoken';
      import { io as createClient } from 'socket.io-client';
      import prisma from './backend/src/lib/prisma';
      import { config } from './backend/src/config/env';
      import { initializeSocketServer } from './backend/src/realtime/socket.server';
      (prisma as any).user = {
        findUnique: async () => ({
          id: 'cli-ws-f08',
          email: 'cli-ws-f08@test.com',
          role: 'CLIENT',
          tokenVersion: 1,
          deletedAt: null,
        }),
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
      };
      (async () => {
        const srv = createServer();
        const io = await initializeSocketServer(srv);
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
        const port = (srv.address() as AddressInfo).port;
        const tok = jwt.sign({ userId: 'cli-ws-f08', role: 'CLIENT', tokenVersion: 1 }, config.JWT_SECRET, {
          algorithm: 'HS256',
          expiresIn: '15m',
        });
        const sock = createClient('http://127.0.0.1:' + port, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          auth: { token: 'Bearer ' + tok, correlationId: 'corr-ws-99' },
        });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('WS timeout')), 4000);
          sock.once('connect', () => { clearTimeout(t); resolve(); });
          sock.once('connect_error', (e) => { clearTimeout(t); reject(e); });
        });
        sock.disconnect();
        await new Promise<void>((r) => io.close(() => srv.close(() => r())));
        process.exit(0);
      })().catch((e) => { console.error(e); process.exit(2); });
      `,
      { NODE_ENV: 'test', LOG_LEVEL: 'info' }
    );
    expect(logRes.status).toBe(0);
    expect(
      logRes.parsedJsonLines.some((line) => JSON.stringify(line).includes('corr-ws-99'))
    ).toBe(true);
  });

  it('T2-F08-01: pino logger redacts password, Authorization token, and sensitive login fields', async () => {
    expect(fs.existsSync(loggerPath)).toBe(true);

    const hashedPassword = await bcrypt.hash('SuperSecretPassword123!', 4);
    const subRes = runTsxSnippet(
      `
      import request from 'supertest';
      import app from './backend/src/app';
      import prisma from './backend/src/lib/prisma';
      (prisma as any).user = {
        findUnique: async () => ({
          id: 'u1',
          email: 'user@test.com',
          password: ${JSON.stringify(hashedPassword)},
          firstName: 'User',
          lastName: 'Test',
          role: 'CLIENT',
          tokenVersion: 1,
          deletedAt: null,
        }),
        update: async () => ({
          id: 'u1',
          email: 'user@test.com',
          password: ${JSON.stringify(hashedPassword)},
          firstName: 'User',
          lastName: 'Test',
          role: 'CLIENT',
          tokenVersion: 2,
          deletedAt: null,
        }),
      };
      request(app)
        .post('/api/auth/login')
        .set('Authorization', 'Bearer secret-jwt-token')
        .send({ email: 'user@test.com', password: 'SuperSecretPassword123!' })
        .then((r) => {
          if (r.status !== 200) {
            console.error('UNEXPECTED_LOGIN_STATUS:' + r.status);
            process.exit(2);
          }
          process.exit(0);
        });
      `,
      { NODE_ENV: 'test', LOG_LEVEL: 'info' }
    );

    expect(subRes.status).toBe(0);
    expect(subRes.parsedJsonLines.length).toBeGreaterThan(0);
    expect(subRes.stdout).not.toContain('SuperSecretPassword123!');
    expect(subRes.stdout).not.toContain('secret-jwt-token');
  });

  it('T2-F08-02: malicious CRLF or oversized X-Request-Id header is sanitized or replaced', async () => {
    server = await startEphemeralServer();

    const crlfRes = await request(server.app)
      .get('/health')
      .set('X-Request-Id', 'bad-id-with-spaces and $bad');
    expect(crlfRes.status).toBe(200);
    const echoed = crlfRes.headers['x-request-id'];
    expect(typeof echoed).toBe('string');
    expect(echoed.length).toBeGreaterThan(0);
    expect(echoed.length).toBeLessThanOrEqual(128);
    expect(echoed).not.toMatch(/[\r\n\s]/);

    const longRes = await request(server.app)
      .get('/health')
      .set('X-Request-Id', 'a'.repeat(500));
    expect(longRes.status).toBe(200);
    expect(typeof longRes.headers['x-request-id']).toBe('string');
    expect(longRes.headers['x-request-id'].length).toBeLessThanOrEqual(128);
  });

  it('T2-F08-03: CORS preflight OPTIONS allows X-Request-Id and X-Correlation-Id headers', async () => {
    server = await startEphemeralServer();

    const res = await request(server.app)
      .options('/api/consultations/mine')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'X-Request-Id, X-Correlation-Id, Authorization');

    expect([200, 204]).toContain(res.status);
    const allowed = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowed).toContain('x-request-id');
    expect(allowed).toContain('x-correlation-id');
  });

  it('T2-F08-04: error envelope includes matching requestId on 413 PAYLOAD_TOO_LARGE', async () => {
    server = await startEphemeralServer();

    const oversizedPayload = JSON.stringify({ data: 'x'.repeat(120 * 1024) });
    const res = await request(server.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('X-Correlation-Id', 'corr-err-500')
      .send(oversizedPayload);

    expect(res.status).toBe(413);
    expect(res.body?.error?.code).toBe('PAYLOAD_TOO_LARGE');
    expect(res.body?.error?.requestId).toBe('corr-err-500');
  });

  it('T2-F08-05: backend/src production source files contain 0 console.* calls', () => {
    const files = collectProdTsFiles(backendSrcDir);
    const hits: string[] = [];

    for (const file of files) {
      const content = stripTsComments(fs.readFileSync(file, 'utf8'));
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line)) {
          hits.push(`${path.relative(repoRoot, file)}:${idx + 1}`);
        }
      });
    }

    expect(hits).toEqual([]);
  });
});
