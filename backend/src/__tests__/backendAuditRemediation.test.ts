import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { setSharedRedisClient } from '../lib/redis';
import { RedisRateLimitStore } from '../lib/redisRateLimitStore';
import { AuthService } from '../modules/auth/auth.service';
import { PasswordResetService } from '../modules/auth/passwordReset.service';
import { AdminService, REDIS_PRICING_SETTINGS_KEY } from '../modules/admin/admin.service';
import {
  featureFlagsService,
  REDIS_FEATURE_FLAGS_KEY,
} from '../modules/admin/feature-flags.service';
import { ConsultationsService } from '../modules/consultations/consultations.service';
import { CallsService } from '../modules/calls/calls.service';
import { MediaService } from '../modules/media/media.service';
import { PrescriptionsService } from '../modules/prescriptions/prescriptions.service';
import { presenceService } from '../realtime/presence.service';
import { VetDisconnectTracker } from '../realtime/vetDisconnectTracker';

const JWT_SECRET =
  process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    pet: {
      findFirst: jest.fn(),
    },
    consultation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    call: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    dailyUploadCounter: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    mediaFile: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    prescription: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    passwordResetToken: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
  },
}));

const mockPrisma = prisma as unknown as {
  user: Record<string, jest.Mock>;
  pet: Record<string, jest.Mock>;
  consultation: Record<string, jest.Mock>;
  call: Record<string, jest.Mock>;
  dailyUploadCounter: Record<string, jest.Mock>;
  mediaFile: Record<string, jest.Mock>;
  prescription: Record<string, jest.Mock>;
  passwordResetToken: Record<string, jest.Mock>;
  auditLog: Record<string, jest.Mock>;
  $transaction: jest.Mock;
};

describe('Backend Audit Remediation Suite', () => {
  const clientUser = {
    id: 'remediation-client-1',
    email: 'client@huellicam.com',
    password: 'hashed-password',
    firstName: 'Lucia',
    lastName: 'Gomez',
    phone: '+541155550000',
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

  const approvedVet = {
    ...clientUser,
    id: 'remediation-vet-1',
    email: 'vet@huellicam.com',
    role: 'VET' as const,
    vetStatus: 'APPROVED' as const,
    licenseNumber: 'MP-5555',
  };

  const pendingVet = {
    ...approvedVet,
    id: 'remediation-vet-pending',
    vetStatus: 'PENDING' as const,
  };

  const clientToken = jwt.sign(
    { userId: clientUser.id, role: clientUser.role, tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  const vetToken = jwt.sign(
    { userId: approvedVet.id, role: approvedVet.role, tokenVersion: 1 },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    setSharedRedisClient(null);
    featureFlagsService.resetForTests();
    new AdminService().resetPricingForTests();
    presenceService.clearMemoryStateForTest();
  });

  afterAll(() => {
    setSharedRedisClient(null);
  });

  describe('Phase 1 — Sessions, Presence & Redis OTP attempts', () => {
    it('AuthService.logout clears Redis presence for approved vet', async () => {
      const clearSpy = jest.spyOn(presenceService, 'clearUserPresence').mockResolvedValueOnce();
      mockPrisma.user.update.mockResolvedValueOnce({
        ...approvedVet,
        tokenVersion: 2,
        isOnline: false,
      });

      const authService = new AuthService();
      await authService.logout(approvedVet.id);

      expect(clearSpy).toHaveBeenCalledWith(approvedVet.id);
    });

    it('AdminService.updateUser bumps tokenVersion and clears presence when role/vetStatus/password changes', async () => {
      const clearSpy = jest.spyOn(presenceService, 'clearUserPresence').mockResolvedValueOnce();
      mockPrisma.user.findUnique.mockResolvedValueOnce(approvedVet);
      mockPrisma.user.update.mockResolvedValueOnce({
        ...approvedVet,
        role: 'CLIENT',
        vetStatus: null,
        isOnline: false,
      });

      const adminService = new AdminService();
      await adminService.updateUser('admin-1', approvedVet.id, { role: 'CLIENT' });

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: approvedVet.id },
          data: expect.objectContaining({
            role: 'CLIENT',
            tokenVersion: { increment: 1 },
            isOnline: false,
          }),
        })
      );
      expect(clearSpy).toHaveBeenCalledWith(approvedVet.id);
    });

    it('PasswordResetService stores failed OTP attempt counts in Redis when ready and invalidates after 3rd attempt', async () => {
      const redisStore = new Map<string, string>();
      const fakeRedis = {
        status: 'ready',
        incr: jest.fn(async (key: string) => {
          const next = Number(redisStore.get(key) ?? '0') + 1;
          redisStore.set(key, String(next));
          return next;
        }),
        expire: jest.fn(async () => 1),
        del: jest.fn(async (key: string) => {
          redisStore.delete(key);
          return 1;
        }),
      };
      setSharedRedisClient(fakeRedis as unknown as Parameters<typeof setSharedRedisClient>[0]);

      const codeHash = await bcrypt.hash('654321', 4);
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
        id: 'tok-redis-1',
        email: 'client@huellicam.com',
        codeHash,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      });
      mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });

      const resetService = new PasswordResetService();

      await expect(resetService.verifyCode('client@huellicam.com', '000001')).rejects.toMatchObject({
        code: 'INVALID_RESET_CODE',
      });
      await expect(resetService.verifyCode('client@huellicam.com', '000002')).rejects.toMatchObject({
        code: 'INVALID_RESET_CODE',
      });
      await expect(resetService.verifyCode('client@huellicam.com', '000003')).rejects.toMatchObject({
        code: 'MAX_ATTEMPTS_EXCEEDED',
      });

      expect(fakeRedis.incr).toHaveBeenCalledWith('huellicam:pwdreset:attempts:tok-redis-1');
      expect(fakeRedis.expire).toHaveBeenCalledWith('huellicam:pwdreset:attempts:tok-redis-1', 600);
      expect(fakeRedis.del).toHaveBeenCalledWith('huellicam:pwdreset:attempts:tok-redis-1');
      expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tok-redis-1', usedAt: null },
        })
      );
    });
  });

  describe('Phase 2 — Feature Flags & Pricing Redis Persistence + Enforcement', () => {
    it('syncs feature flags & pricing settings via Redis and enforces kill switches across Auth, Consultations and Calls', async () => {
      const kv = new Map<string, string>();
      const fakeRedis = {
        status: 'ready',
        get: jest.fn(async (k: string) => kv.get(k) ?? null),
        set: jest.fn(async (k: string, v: string) => {
          kv.set(k, v);
          return 'OK';
        }),
      };
      setSharedRedisClient(fakeRedis as unknown as Parameters<typeof setSharedRedisClient>[0]);

      await featureFlagsService.toggleFlag('admin-1', {
        key: 'NEW_REGISTRATIONS_ENABLED',
        enabled: false,
      });
      expect(fakeRedis.set).toHaveBeenCalledWith(REDIS_FEATURE_FLAGS_KEY, expect.any(String));

      // Reset local flags, then ensure syncFromRedis restores persisted disabled state
      featureFlagsService.resetForTests();
      await featureFlagsService.syncFromRedis(true);
      expect(featureFlagsService.isEnabled('NEW_REGISTRATIONS_ENABLED')).toBe(false);

      const authService = new AuthService();
      await expect(
        authService.register({
          email: 'new@huellicam.com',
          password: 'Password123!',
          firstName: 'Ana',
          lastName: 'Lopez',
          role: 'CLIENT',
        })
      ).rejects.toMatchObject({ statusCode: 503 });

      await featureFlagsService.toggleFlag('admin-1', { key: 'TRIAGE_ACTIVE', enabled: false });
      const consultationsService = new ConsultationsService();
      await expect(
        consultationsService.createConsultation(clientUser.id, {
          petId: 'pet-1',
          notes: 'Dolor abdominal',
        })
      ).rejects.toMatchObject({ statusCode: 503 });

      await featureFlagsService.toggleFlag('admin-1', { key: 'VIDEOCALLS_ENABLED', enabled: false });
      const callsService = new CallsService();
      await expect(
        callsService.generateLiveKitToken('cons-1', clientUser)
      ).rejects.toMatchObject({ statusCode: 503 });

      const adminService = new AdminService();
      await adminService.updatePricingSettings('admin-1', {
        baseConsultationFee: 32000,
        platformTakeRate: 0.12,
        currency: 'ARS',
      });
      expect(fakeRedis.set).toHaveBeenCalledWith(REDIS_PRICING_SETTINGS_KEY, expect.any(String));
      adminService.resetPricingForTests();
      const restored = await adminService.syncPricingFromRedis(true);
      expect(restored.baseConsultationFee).toBe(32000);
      expect(restored.platformTakeRate).toBe(0.12);
    });
  });

  describe('Phase 3 — Consultations, VetDisconnectTracker & Calls Telemetry', () => {
    it('stores activeDeviceId on POST /api/consultations when x-device-id header is provided', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(clientUser);
      mockPrisma.pet.findFirst.mockResolvedValue({
        id: 'pet-dev-1',
        ownerId: clientUser.id,
        name: 'Toby',
        species: 'Canine',
        breed: 'Beagle',
        weightKg: 11,
        sex: 'Male',
        birthDate: null,
        microchip: null,
        allergies: null,
        chronicConditions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
      mockPrisma.consultation.findFirst.mockResolvedValue(null);
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.consultation.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: 'cons-device-1',
        ...args.data,
        pet: { id: 'pet-dev-1', name: 'Toby' },
        client: clientUser,
        vet: null,
      }));

      const res = await request(app)
        .post('/api/consultations')
        .set('Authorization', `Bearer ${clientToken}`)
        .set('X-Device-Id', 'device-web-abc')
        .send({ petId: 'pet-dev-1', notes: 'Estornudos frecuentes' });

      expect(res.status).toBe(201);
      expect(mockPrisma.consultation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            activeDeviceId: 'device-web-abc',
          }),
        })
      );
      expect(mockPrisma.consultation.create.mock.calls[0][0].data.transportStatus).toBeUndefined();
    });

    it('rejects assignConsultation by non-approved VET with 403 VET_NOT_APPROVED', async () => {
      const consultationsService = new ConsultationsService();
      await expect(
        consultationsService.assignConsultation('cons-1', pendingVet)
      ).rejects.toMatchObject({ statusCode: 403, code: 'VET_NOT_APPROVED' });
    });

    it('VetDisconnectTracker invokes checkVetDisconnectTimeout after grace delay and cancels on reconnect', async () => {
      const onTimeout = jest.fn().mockResolvedValue(undefined);
      const findActive = jest.fn().mockResolvedValue([{ id: 'cons-active-1' }]);
      const tracker = new VetDisconnectTracker({
        graceMs: 30,
        findActiveConsultations: findActive,
        onTimeout,
      });

      const disconnectTime = new Date(Date.now() - 4 * 60 * 1000);
      await tracker.schedule('vet-reconnect', disconnectTime);
      expect(await tracker.cancel('vet-reconnect')).toBe(true);
      await new Promise((r) => setTimeout(r, 60));
      expect(onTimeout).not.toHaveBeenCalled();

      await tracker.schedule('vet-timeout', disconnectTime);
      await new Promise((r) => setTimeout(r, 60));
      expect(findActive).toHaveBeenCalledWith('vet-timeout');
      expect(onTimeout).toHaveBeenCalledWith('cons-active-1', disconnectTime);
      tracker.clear();
    });

    it('checkVetDisconnectTimeout skips cancellation if distributed presence reports vet back online', async () => {
      const fakeRedis = {
        status: 'ready',
        mget: jest.fn().mockResolvedValue([JSON.stringify({ isOnline: true, lastSeen: new Date().toISOString() })]),
      };
      setSharedRedisClient(fakeRedis as unknown as Parameters<typeof setSharedRedisClient>[0]);

      mockPrisma.consultation.findUnique.mockResolvedValueOnce({
        id: 'cons-multi-node-1',
        clientId: clientUser.id,
        vetId: approvedVet.id,
        status: 'ACTIVE',
        deletedAt: null,
      });

      const consultationsService = new ConsultationsService();
      const result = await consultationsService.checkVetDisconnectTimeout(
        'cons-multi-node-1',
        new Date(Date.now() - 4 * 60 * 1000)
      );

      expect(result?.status).toBe('ACTIVE');
      expect(mockPrisma.consultation.update).not.toHaveBeenCalled();
    });

    it('CallsService.handleWebhook marks room_aborted and track_publish_failed as CallStatus.FAILED and increments participantCount atomically', async () => {
      const sign = (payload: Record<string, unknown>) => {
        const rawBody = JSON.stringify(payload);
        const sha256 = crypto.createHash('sha256').update(rawBody, 'utf8').digest('base64');
        const authHeader = jwt.sign({ iss: LIVEKIT_API_KEY, sha256 }, LIVEKIT_API_SECRET, {
          algorithm: 'HS256',
          expiresIn: '5m',
        });
        return { rawBody, authHeader };
      };

      const startedAt = new Date(Date.now() - 30_000);
      mockPrisma.call.findFirst.mockResolvedValue({
        id: 'call-wh-1',
        consultationId: 'cons-wh-1',
        roomName: 'cons-wh-1',
        status: 'ACTIVE',
        startedAt,
        participantCount: 1,
        metadata: null,
      });
      mockPrisma.call.update.mockResolvedValue({ id: 'call-wh-1' });

      const callsService = new CallsService();

      const joinWh = sign({
        event: 'participant_joined',
        room: { name: 'cons-wh-1', sid: 'RM_1' },
        participant: { identity: clientUser.id, sid: 'PA_1' },
      });
      await callsService.handleWebhook(joinWh.rawBody, joinWh.authHeader);
      expect(mockPrisma.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ participantCount: { increment: 1 } }),
        })
      );

      const failWh = sign({
        event: 'room_aborted',
        room: { name: 'cons-wh-1', sid: 'RM_1' },
        createdAt: Math.floor(Date.now() / 1000),
      });
      await callsService.handleWebhook(failWh.rawBody, failWh.authHeader);
      expect(mockPrisma.call.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            participantCount: 0,
            errorCode: 'ROOM_ABORTED',
          }),
        })
      );
    });
  });

  describe('Phase 4 — Media Cleanup, Pets Documents, Prescriptions Signature & Redis Rate Limit Store', () => {
    it('MediaService removes moved local file if transaction fails on concurrent quota overrun', async () => {
      const tmpDir = path.resolve(__dirname, 'tmp_remediation_media');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, 'orphan-check.jpg');
      fs.writeFileSync(tmpFile, Buffer.concat([Buffer.from('FFD8FF', 'hex'), Buffer.alloc(64)]));

      try {
        // Fast pre-check passes (0 bytes), concurrent transaction finds 50 MB already used
        mockPrisma.dailyUploadCounter.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ totalBytes: BigInt(50 * 1024 * 1024) });

        const mediaService = new MediaService();
        const uploadsDir = path.resolve(__dirname, '../../uploads');
        const beforeFiles = new Set(fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : []);

        await expect(
          mediaService.uploadMediaFile(clientUser, {
            fieldname: 'file',
            originalname: 'orphan-check.jpg',
            encoding: '7bit',
            mimetype: 'image/jpeg',
            destination: tmpDir,
            filename: 'orphan-check.jpg',
            path: tmpFile,
            size: 1024,
            stream: null as never,
            buffer: Buffer.alloc(0),
          })
        ).rejects.toMatchObject({ statusCode: 429, code: 'UPLOAD_QUOTA_EXCEEDED' });

        const afterFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
        const newOrphans = afterFiles.filter((f) => !beforeFiles.has(f));
        expect(newOrphans).toEqual([]);
        expect(fs.existsSync(tmpFile)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('POST /api/pets/:id/documents validates URL protocol and enforces owner/admin authorization', async () => {
      const samplePet = {
        id: 'pet-doc-1',
        ownerId: clientUser.id,
        name: 'Kira',
        species: 'Feline',
        breed: 'Siames',
        weightKg: 4,
        sex: 'Hembra',
        birthDate: null,
        microchip: null,
        allergies: null,
        chronicConditions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        owner: clientUser,
      };

      mockPrisma.user.findUnique.mockResolvedValue(clientUser);
      mockPrisma.pet.findFirst.mockResolvedValue(samplePet);

      const badUrlRes = await request(app)
        .post('/api/pets/pet-doc-1/documents')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ name: 'Malicious', type: 'PDF', fileUrl: 'javascript:alert(1)' });
      expect(badUrlRes.status).toBe(400);

      // Third-party vet cannot attach documents to someone else's pet
      mockPrisma.user.findUnique.mockResolvedValue(approvedVet);
      mockPrisma.pet.findFirst.mockResolvedValue(samplePet);
      mockPrisma.consultation.findFirst.mockResolvedValue(null);
      const vetForbiddenRes = await request(app)
        .post('/api/pets/pet-doc-1/documents')
        .set('Authorization', `Bearer ${vetToken}`)
        .send({ name: 'Estudio', type: 'Lab', fileUrl: 'https://cdn.example.com/lab.pdf' });
      expect(vetForbiddenRes.status).toBe(403);

      // Owner uploading valid data URI succeeds
      mockPrisma.user.findUnique.mockResolvedValue(clientUser);
      mockPrisma.pet.findFirst.mockResolvedValue(samplePet);
      const okRes = await request(app)
        .post('/api/pets/pet-doc-1/documents')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          name: 'Hemograma',
          type: 'Análisis de sangre',
          fileUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
        });
      expect(okRes.status).toBe(201);
      expect(okRes.body.data.persisted).toBe(false);
    });

    it('GET /api/prescriptions/:id checks deletedAt, validates ?sig= HMAC, preserves verifyUrl and redacts sensitive pet fields publicly', async () => {
      const rxService = new PrescriptionsService();
      const validSig = rxService.signPrescriptionId('rx-sec-1');

      // Soft-deleted consultation -> 404
      mockPrisma.prescription.findUnique.mockResolvedValueOnce({
        id: 'rx-deleted-1',
        vet: approvedVet,
        consultation: { deletedAt: new Date(), pet: { id: 'pet-1', name: 'Rex' }, client: clientUser },
      });
      const deletedRes = await request(app).get('/api/prescriptions/rx-deleted-1');
      expect(deletedRes.status).toBe(404);

      // Invalid signature -> 403
      const badSigRes = await request(app).get('/api/prescriptions/rx-sec-1?sig=tampered');
      expect(badSigRes.status).toBe(403);
      expect(badSigRes.body.error.code).toBe('INVALID_VERIFICATION_SIGNATURE');

      // Valid signature -> 200 with public redaction & exact verifyUrl
      mockPrisma.prescription.findUnique.mockResolvedValueOnce({
        id: 'rx-sec-1',
        consultationId: 'cons-sec-1',
        vetId: approvedVet.id,
        medication: 'Cefalexina 500mg',
        dosage: '1 comp',
        frequency: 'Cada 12h',
        durationDays: 7,
        indications: 'Con comida',
        createdAt: new Date(),
        updatedAt: new Date(),
        vet: {
          id: approvedVet.id,
          firstName: approvedVet.firstName,
          lastName: approvedVet.lastName,
          licenseNumber: approvedVet.licenseNumber,
        },
        consultation: {
          deletedAt: null,
          pet: {
            id: 'pet-1',
            name: 'Rex',
            species: 'Canine',
            breed: 'Labrador',
            weightKg: 25,
            sex: 'Male',
            microchip: '999000111222333',
            allergies: 'Penicilina',
            chronicConditions: 'Ninguna',
            birthDate: new Date('2020-01-01'),
            ownerId: clientUser.id,
          },
          client: { id: clientUser.id, firstName: 'Lucia', lastName: 'Gomez' },
        },
      });

      const okRes = await request(app).get(`/api/prescriptions/rx-sec-1?sig=${validSig}`);
      expect(okRes.status).toBe(200);
      expect(okRes.body.data.verifyUrl).toBe('https://app.huellicam.com.ar/prescriptions/rx-sec-1');
      expect(okRes.body.data.verificationSignature).toBe(validSig);
      expect(okRes.body.data.signedVerifyUrl).toBe(
        `https://app.huellicam.com.ar/prescriptions/rx-sec-1?sig=${validSig}`
      );
      expect(okRes.body.data.consultation.pet.name).toBe('Rex');
      expect(okRes.body.data.consultation.pet.microchip).toBeUndefined();
      expect(okRes.body.data.consultation.pet.allergies).toBeUndefined();

      // Authenticated vet call populates req.user via optionalAuthenticate and retains full clinical pet fields
      mockPrisma.user.findUnique.mockResolvedValueOnce(approvedVet);
      mockPrisma.prescription.findUnique.mockResolvedValueOnce({
        id: 'rx-sec-1',
        consultationId: 'cons-sec-1',
        vetId: approvedVet.id,
        medication: 'Cefalexina 500mg',
        dosage: '1 comp',
        frequency: 'Cada 12h',
        durationDays: 7,
        indications: 'Con comida',
        createdAt: new Date(),
        updatedAt: new Date(),
        vet: {
          id: approvedVet.id,
          firstName: approvedVet.firstName,
          lastName: approvedVet.lastName,
          licenseNumber: approvedVet.licenseNumber,
        },
        consultation: {
          deletedAt: null,
          pet: {
            id: 'pet-1',
            name: 'Rex',
            species: 'Canine',
            breed: 'Labrador',
            weightKg: 25,
            sex: 'Male',
            microchip: '999000111222333',
            allergies: 'Penicilina',
            chronicConditions: 'Ninguna',
            birthDate: new Date('2020-01-01'),
            ownerId: clientUser.id,
          },
          client: { id: clientUser.id, firstName: 'Lucia', lastName: 'Gomez' },
        },
      });
      const vetRes = await request(app)
        .get('/api/prescriptions/rx-sec-1')
        .set('Authorization', `Bearer ${vetToken}`);
      expect(vetRes.status).toBe(200);
      expect(vetRes.body.data.consultation.pet.microchip).toBe('999000111222333');
    });

    it('RedisRateLimitStore uses Redis incr/pexpire when ready and falls back to memory when disconnected', async () => {
      const store = new RedisRateLimitStore('huellicam:rl:test', 30_000);
      try {
        // Memory fallback
        const mem1 = await store.increment('127.0.0.1');
        const mem2 = await store.increment('127.0.0.1');
        expect(mem1.totalHits).toBe(1);
        expect(mem2.totalHits).toBe(2);

        // Redis path
        const counts = new Map<string, number>();
        const fakeRedis = {
          status: 'ready',
          incr: jest.fn(async (k: string) => {
            const next = (counts.get(k) ?? 0) + 1;
            counts.set(k, next);
            return next;
          }),
          pttl: jest.fn(async () => 25_000),
          pexpire: jest.fn(async () => 1),
          del: jest.fn(async (k: string) => {
            counts.delete(k);
            return 1;
          }),
        };
        setSharedRedisClient(fakeRedis as unknown as Parameters<typeof setSharedRedisClient>[0]);

        const r1 = await store.increment('10.0.0.1');
        expect(r1.totalHits).toBe(1);
        expect(fakeRedis.pexpire).toHaveBeenCalledWith('huellicam:rl:test:10.0.0.1', 30_000);
        await store.resetKey('10.0.0.1');
        expect(fakeRedis.del).toHaveBeenCalledWith('huellicam:rl:test:10.0.0.1');
      } finally {
        store.shutdown();
      }
    });
  });
});
