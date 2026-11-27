import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role, VetStatus, ConsultationStatus, FollowUpStatus } from '@prisma/client';
import app from '../app';
import prisma from '../lib/prisma';

jest.mock('../lib/prisma', () => {
  const mockPrismaObj = {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    pet: { findFirst: jest.fn() },
    petCoOwner: { findFirst: jest.fn() },
    vetAvailabilitySlot: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    consultation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    consultationMetadata: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    consultationAuditLog: { create: jest.fn() },
    followUp: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    notification: { create: jest.fn() },
    notificationPreference: { findUnique: jest.fn() },
    webPushSubscription: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  mockPrismaObj.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockPrismaObj));
  return {
    __esModule: true,
    default: mockPrismaObj,
  };
});

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

const mockVet = {
  id: 'vet-sched-1',
  email: 'vet.sched@huellicam.com',
  firstName: 'Laura',
  lastName: 'Gómez',
  role: Role.VET,
  vetStatus: VetStatus.APPROVED,
  deletedAt: null,
};

const mockClient = {
  id: 'client-sched-1',
  email: 'client.sched@huellicam.com',
  firstName: 'Ana',
  lastName: 'Pérez',
  role: Role.CLIENT,
  vetStatus: null,
  deletedAt: null,
};

describe('Scheduling, Rescheduling & Follow-up Endpoints', () => {
  const vetToken = jwt.sign({ userId: mockVet.id, role: Role.VET }, JWT_SECRET);
  const clientToken = jwt.sign({ userId: mockClient.id, role: Role.CLIENT }, JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb(prisma));
  });

  it('allows an approved vet to save and read weekly availability slots via PUT/GET /api/scheduling/vets/me/availability', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockVet);
    (prisma.vetAvailabilitySlot.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.vetAvailabilitySlot.createMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.vetAvailabilitySlot.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'slot-1',
        vetId: mockVet.id,
        dayOfWeek: 1,
        startTime: '09:00',
        endTime: '12:00',
        slotDurationMin: 30,
        isActive: true,
      },
    ]);

    const res = await request(app)
      .put('/api/scheduling/vets/me/availability')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({
        slots: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00', slotDurationMin: 30, isActive: true }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].startTime).toBe('09:00');
  });

  it('prevents double booking and creates scheduled appointment with ConsultationMetadata', async () => {
    const futureIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockClient);
    (prisma.pet.findFirst as jest.Mock).mockResolvedValue({ id: 'pet-1', ownerId: mockClient.id, name: 'Milo' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(mockVet);
    (prisma.consultationMetadata.findFirst as jest.Mock)
      .mockResolvedValueOnce({ consultationId: 'existing-c' })
      .mockResolvedValueOnce(null);

    const conflictRes = await request(app)
      .post('/api/scheduling/appointments')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        petId: 'pet-1',
        vetId: mockVet.id,
        scheduledAt: futureIso,
        notes: 'Control anual',
      });

    expect(conflictRes.status).toBe(409);

    (prisma.consultation.create as jest.Mock).mockResolvedValue({
      id: 'cons-sched-1',
      clientId: mockClient.id,
      petId: 'pet-1',
      vetId: mockVet.id,
      status: ConsultationStatus.WAITING,
      notes: 'Control anual',
    });
    (prisma.consultationMetadata.create as jest.Mock).mockResolvedValue({
      consultationId: 'cons-sched-1',
      scheduledAt: new Date(futureIso),
    });
    (prisma.consultationAuditLog.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: 'notif-1' });

    const okRes = await request(app)
      .post('/api/scheduling/appointments')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        petId: 'pet-1',
        vetId: mockVet.id,
        scheduledAt: futureIso,
        notes: 'Control anual',
      });

    expect(okRes.status).toBe(201);
    expect(okRes.body.data.scheduledAt).toBe(futureIso);
  });

  it('reschedules an existing waiting consultation via PATCH /api/consultations/:id/reschedule', async () => {
    const newIso = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockVet);
    (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
      id: 'cons-1',
      clientId: mockClient.id,
      vetId: mockVet.id,
      petId: 'pet-1',
      status: ConsultationStatus.WAITING,
      stateVersion: 1,
      deletedAt: null,
    });
    (prisma.consultationMetadata.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.consultation.update as jest.Mock).mockResolvedValue({
      id: 'cons-1',
      clientId: mockClient.id,
      vetId: mockVet.id,
      status: ConsultationStatus.WAITING,
      stateVersion: 2,
    });
    (prisma.consultationMetadata.upsert as jest.Mock).mockResolvedValue({
      consultationId: 'cons-1',
      scheduledAt: new Date(newIso),
    });
    (prisma.consultationAuditLog.create as jest.Mock).mockResolvedValue({ id: 'audit-2' });
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: 'notif-2' });

    const res = await request(app)
      .patch('/api/consultations/cons-1/reschedule')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({ scheduledAt: newIso, reason: 'Cambio solicitado por tutor' });

    expect(res.status).toBe(200);
    expect(res.body.data.scheduledAt).toBe(newIso);
  });

  it('creates and completes a clinical follow-up via /api/scheduling/follow-ups', async () => {
    const dueIso = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockVet);
    (prisma.pet.findFirst as jest.Mock).mockResolvedValue({ id: 'pet-1', ownerId: mockClient.id, name: 'Milo' });
    (prisma.followUp.create as jest.Mock).mockResolvedValue({
      id: 'fu-1',
      petId: 'pet-1',
      vetId: mockVet.id,
      clientId: mockClient.id,
      consultationId: null,
      title: 'Control de sutura',
      notes: 'Revisar cicatriz',
      dueAt: new Date(dueIso),
      status: FollowUpStatus.PENDING,
      createdAt: new Date(),
      pet: { id: 'pet-1', name: 'Milo' },
      vet: { id: mockVet.id, firstName: 'Laura', lastName: 'Gómez' },
    });
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: 'notif-3' });

    const createRes = await request(app)
      .post('/api/scheduling/follow-ups')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({
        petId: 'pet-1',
        title: 'Control de sutura',
        notes: 'Revisar cicatriz',
        dueAt: dueIso,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.status).toBe('PENDING');

    (prisma.followUp.findUnique as jest.Mock).mockResolvedValue({
      id: 'fu-1',
      petId: 'pet-1',
      vetId: mockVet.id,
      clientId: mockClient.id,
      status: FollowUpStatus.PENDING,
      dueAt: new Date(dueIso),
      createdAt: new Date(),
    });
    (prisma.followUp.update as jest.Mock).mockResolvedValue({
      id: 'fu-1',
      petId: 'pet-1',
      vetId: mockVet.id,
      clientId: mockClient.id,
      consultationId: null,
      title: 'Control de sutura',
      notes: 'Revisar cicatriz',
      dueAt: new Date(dueIso),
      status: FollowUpStatus.COMPLETED,
      createdAt: new Date(),
    });

    const patchRes = await request(app)
      .patch('/api/scheduling/follow-ups/fu-1')
      .set('Authorization', `Bearer ${vetToken}`)
      .send({ status: 'COMPLETED' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('COMPLETED');
  });
});
