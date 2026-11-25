import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import prisma from '../../../backend/src/lib/prisma';
import { attachInMemoryPrisma, InMemoryPrisma } from '../helpers/node/inMemoryPrisma';
import {
  EphemeralServerHandle,
  mintAccessToken,
  startEphemeralServer,
} from '../helpers/node/ephemeralServer';
import { signLiveKitWebhook } from '../helpers/node/livekitWebhook';

const repoRoot = path.resolve(__dirname, '../../..');

describe('F09 — LiveKit Webhooks Linked to Call Model (M4)', () => {
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

  async function seedActiveConsultation() {
    await memPrisma.user.create({
      data: {
        id: 'cli-call',
        email: 'cli-call@test.com',
        password: 'hash',
        firstName: 'Tutor',
        lastName: 'Call',
        role: 'CLIENT',
        tokenVersion: 1,
      },
    });
    await memPrisma.user.create({
      data: {
        id: 'vet-call',
        email: 'vet-call@test.com',
        password: 'hash',
        firstName: 'Dr',
        lastName: 'Call',
        role: 'VET',
        vetStatus: 'APPROVED',
        tokenVersion: 1,
      },
    });
    await memPrisma.consultation.create({
      data: {
        id: 'c-1',
        clientId: 'cli-call',
        vetId: 'vet-call',
        petId: 'pet-call',
        status: 'ACTIVE',
      },
    });
  }

  it('T1-F09-01: POST /api/calls/:consultationId/token creates/persists Call row with status INITIATED', async () => {
    await seedActiveConsultation();
    server = await startEphemeralServer();
    const token = mintAccessToken({ id: 'vet-call', role: 'VET', tokenVersion: 1 });

    const res = await request(server.app)
      .post('/api/calls/c-1/token')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body?.data?.roomName).toBe('c-1');
    expect(typeof res.body?.data?.token).toBe('string');

    const calls = await memPrisma.call.findMany({ where: { consultationId: 'c-1' } });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toMatchObject({
      consultationId: 'c-1',
      roomName: 'c-1',
      status: 'INITIATED',
    });
  });

  it('T1-F09-02: POST /api/calls/webhook room_started updates Call to ACTIVE with startedAt', async () => {
    await seedActiveConsultation();
    await memPrisma.call.create({
      data: {
        id: 'call-1',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'INITIATED',
      },
    });

    server = await startEphemeralServer();
    const { rawBody, authHeader } = signLiveKitWebhook({
      event: 'room_started',
      room: { name: 'c-1', sid: 'RM_START_123' },
      createdAt: Math.floor(Date.now() / 1000),
    });

    const res = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', authHeader)
      .send(rawBody);

    expect(res.status).toBe(200);

    const updated = await memPrisma.call.findUnique({ where: { id: 'call-1' } });
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.startedAt).toBeInstanceOf(Date);
  });

  it('T1-F09-03: POST /api/calls/webhook room_finished updates Call to ENDED with accurate durationSeconds', async () => {
    await seedActiveConsultation();
    const startedAt = new Date(Date.now() - 125_000);
    await memPrisma.call.create({
      data: {
        id: 'call-fin',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'ACTIVE',
        startedAt,
      },
    });

    server = await startEphemeralServer();
    const { rawBody, authHeader } = signLiveKitWebhook({
      event: 'room_finished',
      room: { name: 'c-1', sid: 'RM_FIN_123' },
      createdAt: Math.floor(Date.now() / 1000),
    });

    const res = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', authHeader)
      .send(rawBody);

    expect(res.status).toBe(200);

    const updated = await memPrisma.call.findUnique({ where: { id: 'call-fin' } });
    expect(updated?.status).toBe('ENDED');
    expect(updated?.endedAt).toBeInstanceOf(Date);
    expect(typeof updated?.durationSeconds).toBe('number');
    expect(updated?.durationSeconds as number).toBeGreaterThanOrEqual(120);
    expect(updated?.durationSeconds as number).toBeLessThanOrEqual(130);
  });

  it('T1-F09-04: POST /api/calls/webhook participant_joined / participant_left records telemetry on Call', async () => {
    await seedActiveConsultation();
    await memPrisma.call.create({
      data: {
        id: 'call-part',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'ACTIVE',
        startedAt: new Date(Date.now() - 30_000),
      },
    });

    server = await startEphemeralServer();
    memPrisma.methodCalls = [];

    const joined = signLiveKitWebhook({
      event: 'participant_joined',
      room: { name: 'c-1', sid: 'RM_PART_1' },
      participant: { identity: 'vet-call', sid: 'PA_1' },
    });
    const r1 = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', joined.authHeader)
      .send(joined.rawBody);
    expect(r1.status).toBe(200);

    const left = signLiveKitWebhook({
      event: 'participant_left',
      room: { name: 'c-1', sid: 'RM_PART_1' },
      participant: { identity: 'vet-call', sid: 'PA_1' },
    });
    const r2 = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', left.authHeader)
      .send(left.rawBody);
    expect(r2.status).toBe(200);

    const callMutations = memPrisma.methodCalls.filter(
      (c) => c.model === 'call' && (c.method === 'update' || c.method === 'updateMany')
    );
    expect(callMutations.length).toBeGreaterThanOrEqual(1);
  });

  it('T1-F09-05: check:governance and prisma validate pass with TECH_REFERENCE.md in sync', () => {
    const govScript = path.join(repoRoot, 'scripts', 'verify-governance.js');
    const prismaCli = path.join(repoRoot, 'backend', 'node_modules', 'prisma', 'build', 'index.js');
    const schemaPath = path.join(repoRoot, 'backend', 'prisma', 'schema.prisma');

    execFileSync(process.execPath, [govScript], { cwd: repoRoot, encoding: 'utf8' });
    execFileSync(process.execPath, [prismaCli, 'validate', '--schema', schemaPath], {
      cwd: path.join(repoRoot, 'backend'),
      encoding: 'utf8',
    });

    const techRef = fs.readFileSync(path.join(repoRoot, 'docs', 'TECH_REFERENCE.md'), 'utf8');
    expect(techRef).toContain('Call');
    expect(techRef).toMatch(/\/api\/calls\/webhook/);
  });

  it('T2-F09-01: missing or tampered HMAC signature returns 401 and makes 0 mutations to prisma.call', async () => {
    await seedActiveConsultation();
    await memPrisma.call.create({
      data: {
        id: 'call-auth',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'ACTIVE',
      },
    });
    memPrisma.methodCalls = [];

    server = await startEphemeralServer();
    const { rawBody, authHeader } = signLiveKitWebhook({
      event: 'room_finished',
      room: { name: 'c-1', sid: 'RM_AUTH' },
    });

    const missingRes = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .send(rawBody);
    expect(missingRes.status).toBe(401);

    const tamperedRes = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', `${authHeader}tampered`)
      .send(rawBody);
    expect([401, 403]).toContain(tamperedRes.status);

    const callMutations = memPrisma.methodCalls.filter(
      (c) => c.model === 'call' && ['create', 'update', 'updateMany'].includes(c.method)
    );
    expect(callMutations).toHaveLength(0);
  });

  it('T2-F09-02: pretty-printed Content-Type application/json webhook preserves raw bytes before express.json()', async () => {
    await seedActiveConsultation();
    await memPrisma.call.create({
      data: {
        id: 'call-raw',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'ACTIVE',
        startedAt: new Date(Date.now() - 40_000),
      },
    });

    server = await startEphemeralServer();
    const { rawBody, authHeader } = signLiveKitWebhook(
      {
        event: 'room_finished',
        room: { name: 'c-1', sid: 'RM_RAW_JSON' },
      },
      { pretty: true }
    );
    expect(rawBody).toContain('\n');

    const res = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/json')
      .set('Authorization', authHeader)
      .send(rawBody);

    expect(res.status).toBe(200);
    const updated = await memPrisma.call.findUnique({ where: { id: 'call-raw' } });
    expect(updated?.status).toBe('ENDED');
  });

  it('T2-F09-03: duplicate room_finished webhook is idempotent and preserves original endedAt/durationSeconds', async () => {
    await seedActiveConsultation();
    const startedAt = new Date(Date.now() - 95_000);
    await memPrisma.call.create({
      data: {
        id: 'call-dup',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'ACTIVE',
        startedAt,
      },
    });

    server = await startEphemeralServer();
    const firstWebhook = signLiveKitWebhook({
      event: 'room_finished',
      room: { name: 'c-1', sid: 'RM_DUP' },
      createdAt: Math.floor(Date.now() / 1000),
    });

    const res1 = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', firstWebhook.authHeader)
      .send(firstWebhook.rawBody);

    expect(res1.status).toBe(200);
    const firstAfter = await memPrisma.call.findUnique({ where: { id: 'call-dup' } });
    expect(firstAfter?.status).toBe('ENDED');
    expect(firstAfter?.endedAt).toBeInstanceOf(Date);
    expect(typeof firstAfter?.durationSeconds).toBe('number');
    expect(firstAfter?.durationSeconds as number).toBeGreaterThanOrEqual(90);

    const originalEndedAtMs = (firstAfter!.endedAt as Date).getTime();
    const originalDuration = firstAfter!.durationSeconds as number;

    await new Promise((r) => setTimeout(r, 1100));

    const duplicateWebhook = signLiveKitWebhook({
      event: 'room_finished',
      room: { name: 'c-1', sid: 'RM_DUP' },
      createdAt: Math.floor(Date.now() / 1000),
    });

    const res2 = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', duplicateWebhook.authHeader)
      .send(duplicateWebhook.rawBody);

    expect(res2.status).toBe(200);
    const secondAfter = await memPrisma.call.findUnique({ where: { id: 'call-dup' } });
    expect(secondAfter?.status).toBe('ENDED');
    expect(secondAfter?.durationSeconds).toBe(originalDuration);
    expect((secondAfter?.endedAt as Date)?.getTime()).toBe(originalEndedAtMs);
  }, 10000);

  it('T2-F09-04: participant_connection_aborted webhook persists diagnostic error/failure telemetry on Call', async () => {
    await seedActiveConsultation();
    await memPrisma.call.create({
      data: {
        id: 'call-telemetry-1',
        consultationId: 'c-1',
        roomName: 'c-1',
        status: 'ACTIVE',
        startedAt: new Date(Date.now() - 20_000),
      },
    });

    server = await startEphemeralServer();
    const { rawBody, authHeader } = signLiveKitWebhook({
      event: 'participant_connection_aborted',
      room: { name: 'c-1', sid: 'RM_TEL_1' },
      participant: { identity: 'cli-call', sid: 'PA_TEL_1' },
    });

    const res = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', authHeader)
      .send(rawBody);

    expect(res.status).toBe(200);
    const updated = await memPrisma.call.findUnique({ where: { id: 'call-telemetry-1' } });
    expect(updated).toBeDefined();
    const { id: _id, roomName: _room, consultationId: _cid, ...telemetryFields } = updated as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(telemetryFields)).toMatch(/abort|error|fail|disconnect/i);
  });

  it('T2-F09-05: webhook for unknown roomName responds 200 gracefully without 500 crash', async () => {
    server = await startEphemeralServer();
    const { rawBody, authHeader } = signLiveKitWebhook({
      event: 'room_started',
      room: { name: 'nonexistent-room-999', sid: 'RM_UNKNOWN' },
    });

    const res = await request(server.app)
      .post('/api/calls/webhook')
      .set('Content-Type', 'application/webhook+json')
      .set('Authorization', authHeader)
      .send(rawBody);

    expect(res.status).toBe(200);
  });
});
