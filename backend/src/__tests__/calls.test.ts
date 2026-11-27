import crypto from 'crypto';
import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import jwt from 'jsonwebtoken';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
    },
    consultation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    call: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

const mockPrismaUser = prisma.user as jest.Mocked<typeof prisma.user>;
const mockPrismaConsultation = prisma.consultation as unknown as {
  findUnique: jest.Mock;
  findFirst: jest.Mock;
  updateMany: jest.Mock;
};
const mockPrismaCall = prisma.call as unknown as {
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

function signWebhookPayload(payload: Record<string, unknown>, pretty = false) {
  const rawBody = JSON.stringify(payload, null, pretty ? 2 : 0);
  const sha256 = crypto.createHash('sha256').update(rawBody, 'utf8').digest('base64');
  const authHeader = jwt.sign({ iss: LIVEKIT_API_KEY, sha256 }, LIVEKIT_API_SECRET, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
  return { rawBody, authHeader };
}

describe('Calls Module (/api/calls)', () => {
  const mockClient = {
    id: 'client-uuid-call-1',
    email: 'client.call@huellicam.com',
    password: 'password',
    firstName: 'Sofia',
    lastName: 'Rios',
    phone: '+541155559999',
    role: 'CLIENT' as const,
    vetStatus: null,
    licenseNumber: null,
    bio: null,
    photoUrl: null,
    tokenVersion: 1,
    ratingAvg: 0,
    ratingCount: 0,
    isOnline: true,
    lastSeen: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const clientToken = jwt.sign(
    { userId: mockClient.id, role: mockClient.role, tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaCall.findFirst.mockResolvedValue(null);
    mockPrismaCall.create.mockImplementation(async (args: any) => ({
      id: 'call-created-1',
      ...args.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockPrismaCall.update.mockImplementation(async (args: any) => ({
      id: args.where.id,
      ...args.data,
    }));
    mockPrismaConsultation.updateMany.mockResolvedValue({ count: 1 } as any);
  });

  describe('POST /api/calls/:consultationId/token (LiveKit SFU)', () => {
    it('should generate LiveKit JWT token WITHOUT any PII and persist Call row', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(mockClient);
      mockPrismaConsultation.findUnique.mockResolvedValue({
        id: 'consultation-call-1',
        clientId: mockClient.id,
        vetId: 'vet-uuid-1',
        petId: 'pet-uuid-1',
        status: 'ACTIVE',
        notes: 'Consulta activa',
        diagnosisNotes: null,
        startedAt: new Date(),
        endedAt: null,
        activeDeviceId: null,
        transportStatus: 'OFFLINE',
        stateVersion: 1,
        claimedAt: null,
        livekitRoomSid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const res = await request(app)
        .post('/api/calls/consultation-call-1/token')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();

      expect(mockPrismaCall.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consultationId: 'consultation-call-1',
            roomName: 'consultation-call-1',
            status: 'INITIATED',
          }),
        })
      );

      // Decode LiveKit JWT token to inspect claims
      const decoded: any = jwt.decode(res.body.data.token);

      expect(decoded.sub).toBe(mockClient.id); // identity = user.id
      expect(decoded.name).toBe(mockClient.firstName); // name = user.firstName
      expect(decoded.email).toBeUndefined(); // ZERO PII
      expect(decoded.phone).toBeUndefined(); // ZERO PII
      expect(decoded.video.room).toBe('consultation-call-1');
      const startTimestamp = decoded.nbf ?? decoded.iat;
      expect(decoded.exp - startTimestamp).toBeLessThanOrEqual(15 * 60); // VULN-08: TTL <= 15m
    });

    it('should REJECT token generation if consultation is not ACTIVE', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(mockClient);
      mockPrismaConsultation.findUnique.mockResolvedValue({
        id: 'consultation-call-waiting',
        clientId: mockClient.id,
        vetId: null,
        petId: 'pet-uuid-1',
        status: 'WAITING',
        notes: 'En espera',
        diagnosisNotes: null,
        startedAt: null,
        endedAt: null,
        activeDeviceId: null,
        transportStatus: 'OFFLINE',
        stateVersion: 1,
        claimedAt: null,
        livekitRoomSid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const res = await request(app)
        .post('/api/calls/consultation-call-waiting/token')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CONSULTATION_STATE');
    });

    it('should bind activeDeviceId via CAS when initially null and reject stale/mismatched x-device-id with 409 DEVICE_SESSION_STALE', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(mockClient);
      mockPrismaConsultation.findUnique.mockResolvedValueOnce({
        id: 'consultation-bind-1',
        clientId: mockClient.id,
        vetId: 'vet-uuid-1',
        petId: 'pet-uuid-1',
        status: 'ACTIVE',
        activeDeviceId: null,
        stateVersion: 1,
        deletedAt: null,
      } as any);
      (mockPrismaConsultation.updateMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const boundRes = await request(app)
        .post('/api/calls/consultation-bind-1/token')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('X-Device-Id', 'device-B-123');

      expect(boundRes.status).toBe(200);
      const boundJwt: any = jwt.decode(boundRes.body.data.token);
      expect(boundJwt.sub).toBe(`tutor_${mockClient.id}:device-B-123`);

      // Mismatched or missing device header once bound -> 409 DEVICE_SESSION_STALE
      mockPrismaConsultation.findUnique.mockResolvedValueOnce({
        id: 'consultation-bind-1',
        clientId: mockClient.id,
        vetId: 'vet-uuid-1',
        petId: 'pet-uuid-1',
        status: 'ACTIVE',
        activeDeviceId: 'device-B-123',
        stateVersion: 2,
        deletedAt: null,
      } as any);

      const staleRes = await request(app)
        .post('/api/calls/consultation-bind-1/token')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('X-Device-Id', 'device-A-old');

      expect(staleRes.status).toBe(409);
      expect(staleRes.body.error.code).toBe('DEVICE_SESSION_STALE');
    });
  });

  describe('POST /api/calls/:consultationId/ring', () => {
    it('should trigger ring signal for ACTIVE consultation participant', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(mockClient);
      mockPrismaConsultation.findUnique.mockResolvedValue({
        id: 'consultation-call-1',
        clientId: mockClient.id,
        vetId: 'vet-uuid-1',
        petId: 'pet-uuid-1',
        status: 'ACTIVE',
        notes: 'Consulta activa',
        diagnosisNotes: null,
        startedAt: new Date(),
        endedAt: null,
        activeDeviceId: null,
        transportStatus: 'OFFLINE',
        stateVersion: 1,
        claimedAt: null,
        livekitRoomSid: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });

      const res = await request(app)
        .post('/api/calls/consultation-call-1/ring')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('RINGING');
      expect(res.body.data.targetUserId).toBe('vet-uuid-1');
    });
  });

  describe('POST /api/calls/webhook (LiveKit Telemetry & Invalidation)', () => {
    it('should reject missing or invalid signature with 401 and perform 0 call mutations', async () => {
      const res = await request(app)
        .post('/api/calls/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ event: 'room_finished', room: { name: 'consultation-call-1' } }));

      expect(res.status).toBe(401);
      expect(mockPrismaCall.update).not.toHaveBeenCalled();

      const badRes = await request(app)
        .post('/api/calls/webhook')
        .set('Content-Type', 'application/webhook+json')
        .set('Authorization', 'invalid.jwt.signature')
        .send(JSON.stringify({ event: 'room_finished', room: { name: 'consultation-call-1' } }));

      expect(badRes.status).toBe(401);
      expect(mockPrismaCall.update).not.toHaveBeenCalled();
    });

    it('should verify pretty application/json signature and update Call lifecycle + duration', async () => {
      const startedAt = new Date(Date.now() - 45_000);
      mockPrismaCall.findFirst.mockResolvedValue({
        id: 'call-1',
        consultationId: 'consultation-call-1',
        roomName: 'consultation-call-1',
        livekitRoomSid: null,
        status: 'ACTIVE',
        startedAt,
        endedAt: null,
        durationSeconds: null,
        participantCount: 1,
        errorCode: null,
        errorMessage: null,
        disconnectReason: null,
        lastEvent: 'room_started',
        metadata: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      } as any);

      const { rawBody, authHeader } = signWebhookPayload(
        {
          event: 'room_finished',
          room: { name: 'consultation-call-1', sid: 'RM_UNIT_1' },
          createdAt: Math.floor(Date.now() / 1000),
        },
        true
      );

      const res = await request(app)
        .post('/api/calls/webhook')
        .set('Content-Type', 'application/json')
        .set('Authorization', authHeader)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(mockPrismaCall.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'call-1' },
          data: expect.objectContaining({
            status: 'ENDED',
            livekitRoomSid: 'RM_UNIT_1',
            durationSeconds: expect.any(Number),
          }),
        })
      );
    });

    it('should keep duplicate room_finished idempotent and record participant_connection_aborted telemetry', async () => {
      const startedAt = new Date(Date.now() - 60_000);
      mockPrismaCall.findFirst.mockResolvedValueOnce({
        id: 'call-ended-1',
        consultationId: 'consultation-call-1',
        roomName: 'consultation-call-1',
        status: 'ENDED',
        startedAt,
        endedAt: new Date(),
        durationSeconds: 60,
      } as any);

      const dup = signWebhookPayload({
        event: 'room_finished',
        room: { name: 'consultation-call-1', sid: 'RM_DUP' },
      });

      const dupRes = await request(app)
        .post('/api/calls/webhook')
        .set('Content-Type', 'application/webhook+json')
        .set('Authorization', dup.authHeader)
        .send(dup.rawBody);

      expect(dupRes.status).toBe(200);
      expect(mockPrismaCall.update).not.toHaveBeenCalled();

      mockPrismaCall.findFirst.mockResolvedValueOnce({
        id: 'call-abort-1',
        consultationId: 'consultation-call-1',
        roomName: 'consultation-call-1',
        status: 'ACTIVE',
        startedAt,
        participantCount: 2,
        metadata: null,
      } as any);

      const abort = signWebhookPayload({
        event: 'participant_connection_aborted',
        room: { name: 'consultation-call-1', sid: 'RM_ABORT' },
        participant: { identity: 'client-1', sid: 'PA_1' },
      });

      const abortRes = await request(app)
        .post('/api/calls/webhook')
        .set('Content-Type', 'application/webhook+json')
        .set('Authorization', abort.authHeader)
        .send(abort.rawBody);

      expect(abortRes.status).toBe(200);
      expect(mockPrismaCall.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'call-abort-1' },
          data: expect.objectContaining({
            errorCode: 'PARTICIPANT_CONNECTION_ABORTED',
            disconnectReason: 'PARTICIPANT_CONNECTION_ABORTED',
          }),
        })
      );
    });
  });
});
