import { ConsultationStatus, Role, VetStatus } from '@prisma/client';

const emittedRecords: Array<{ rooms: string | string[]; event: string; data: any }> = [];

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    consultation: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    prescription: {
      create: jest.fn(),
    },
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    },
  },
}));

jest.mock('../services/email.service', () => ({
  emailService: {
    sendPrescriptionEmail: jest.fn().mockResolvedValue(true),
  },
}));

jest.mock('../modules/calls/calls.service', () => ({
  CallsService: jest.fn().mockImplementation(() => ({
    deleteLiveKitRoom: jest.fn().mockResolvedValue(undefined),
  })),
}));

const defaultMockIo = {
  to: jest.fn((rooms: string | string[]) => ({
    emit: jest.fn((event: string, data: any) => {
      emittedRecords.push({ rooms, event, data });
    }),
  })),
  in: jest.fn(() => ({
    disconnectSockets: jest.fn(),
    socketsLeave: jest.fn(),
  })),
};

let activeMockIo: any = defaultMockIo;

jest.mock('../realtime/socket.server', () => ({
  get io() {
    return activeMockIo;
  },
}));

import prisma from '../lib/prisma';
import { ConsultationsService } from '../modules/consultations/consultations.service';
import { PrescriptionsService } from '../modules/prescriptions/prescriptions.service';
import { UsersService } from '../modules/users/users.service';

describe('Reactive Socket.io Events (M3)', () => {
  const mockPrismaConsultation = prisma.consultation as jest.Mocked<typeof prisma.consultation>;
  const mockPrismaPrescription = prisma.prescription as jest.Mocked<typeof prisma.prescription>;
  const mockPrismaUser = prisma.user as jest.Mocked<typeof prisma.user>;

  const vetUser = {
    id: 'vet-ev-1',
    role: Role.VET,
    vetStatus: VetStatus.APPROVED,
    firstName: 'Carlos',
    lastName: 'Mendoza',
  } as any;

  const clientUser = {
    id: 'client-ev-1',
    role: Role.CLIENT,
    firstName: 'Lucia',
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    emittedRecords.length = 0;
  });

  it('assignConsultation emits consultation:assigned after CAS success and does NOT emit on 409 CAS conflict', async () => {
    const service = new ConsultationsService();
    const waiting = {
      id: 'cons-assign-1',
      clientId: 'client-ev-1',
      vetId: null,
      petId: 'pet-1',
      status: ConsultationStatus.WAITING,
      stateVersion: 1,
      deletedAt: null,
      createdAt: new Date(),
    };

    mockPrismaConsultation.findUnique
      .mockResolvedValueOnce(waiting as any)
      .mockResolvedValueOnce(waiting as any)
      .mockResolvedValueOnce({
        ...waiting,
        vetId: vetUser.id,
        status: ConsultationStatus.ACTIVE,
        stateVersion: 2,
        client: { id: 'client-ev-1', email: 'secret@example.com', phone: '+5491112345678' },
      } as any);
    (mockPrismaConsultation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await service.assignConsultation('cons-assign-1', vetUser);

    expect(emittedRecords).toContainEqual({
      rooms: ['consultation:cons-assign-1', 'role:vets', 'user:client-ev-1'],
      event: 'consultation:assigned',
      data: {
        consultationId: 'cons-assign-1',
        vetId: 'vet-ev-1',
        clientId: 'client-ev-1',
        status: ConsultationStatus.ACTIVE,
      },
    });
    // Ensure zero PII on role:vets payload
    const assignedPayload = emittedRecords.find((r) => r.event === 'consultation:assigned')!.data;
    expect(assignedPayload.email).toBeUndefined();
    expect(assignedPayload.phone).toBeUndefined();
    expect(assignedPayload.notes).toBeUndefined();

    // CAS conflict must NOT emit consultation:assigned
    emittedRecords.length = 0;
    mockPrismaConsultation.findUnique
      .mockResolvedValueOnce(waiting as any)
      .mockResolvedValueOnce(waiting as any);
    (mockPrismaConsultation.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(service.assignConsultation('cons-assign-1', vetUser)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(emittedRecords.filter((r) => r.event === 'consultation:assigned')).toHaveLength(0);
  });

  it('completeConsultation emits call:ended to consultation, client, and vet rooms (deduplicated)', async () => {
    const service = new ConsultationsService();
    mockPrismaConsultation.findUnique.mockResolvedValue({
      id: 'cons-comp-1',
      clientId: 'client-ev-1',
      vetId: 'vet-ev-1',
      status: ConsultationStatus.ACTIVE,
      deletedAt: null,
    } as any);
    mockPrismaConsultation.update.mockResolvedValue({
      id: 'cons-comp-1',
      clientId: 'client-ev-1',
      vetId: 'vet-ev-1',
      status: ConsultationStatus.COMPLETED,
    } as any);

    await service.completeConsultation('cons-comp-1', vetUser, { diagnosisNotes: 'OK' } as any);

    expect(emittedRecords).toContainEqual({
      rooms: ['consultation:cons-comp-1', 'user:client-ev-1', 'user:vet-ev-1'],
      event: 'call:ended',
      data: {
        consultationId: 'cons-comp-1',
        endedBy: 'vet-ev-1',
      },
    });
  });

  it('cancelConsultation, checkTriageTimeout, and checkVetDisconnectTimeout emit consultation:cancelled', async () => {
    const service = new ConsultationsService();

    // Manual cancel
    mockPrismaConsultation.findUnique.mockResolvedValue({
      id: 'cons-cancel-1',
      clientId: 'client-ev-1',
      vetId: 'vet-ev-1',
      status: ConsultationStatus.WAITING,
      notes: 'Triage',
      deletedAt: null,
    } as any);
    mockPrismaConsultation.update.mockResolvedValue({
      id: 'cons-cancel-1',
      clientId: 'client-ev-1',
      status: ConsultationStatus.CANCELLED,
    } as any);

    await service.cancelConsultation('cons-cancel-1', clientUser, { reason: 'Resolved' });
    expect(emittedRecords).toContainEqual({
      rooms: ['consultation:cons-cancel-1', 'role:vets', 'user:client-ev-1'],
      event: 'consultation:cancelled',
      data: {
        consultationId: 'cons-cancel-1',
        cancelledBy: 'client-ev-1',
        status: ConsultationStatus.CANCELLED,
      },
    });

    // Triage timeout
    emittedRecords.length = 0;
    const oldDate = new Date(Date.now() - 20 * 60 * 1000);
    mockPrismaConsultation.findUnique.mockResolvedValue({
      id: 'cons-triage-to',
      clientId: 'client-ev-1',
      status: ConsultationStatus.WAITING,
      createdAt: oldDate,
    } as any);
    mockPrismaConsultation.update.mockResolvedValue({
      id: 'cons-triage-to',
      clientId: 'client-ev-1',
      status: ConsultationStatus.CANCELLED,
    } as any);
    await service.checkTriageTimeout('cons-triage-to');
    expect(emittedRecords).toContainEqual({
      rooms: ['consultation:cons-triage-to', 'role:vets', 'user:client-ev-1'],
      event: 'consultation:cancelled',
      data: {
        consultationId: 'cons-triage-to',
        cancelledBy: 'SYSTEM_TIMEOUT',
        status: ConsultationStatus.CANCELLED,
      },
    });

    // Vet disconnect timeout
    emittedRecords.length = 0;
    mockPrismaConsultation.findUnique.mockResolvedValue({
      id: 'cons-vet-to',
      clientId: 'client-ev-1',
      status: ConsultationStatus.ACTIVE,
    } as any);
    mockPrismaConsultation.update.mockResolvedValue({
      id: 'cons-vet-to',
      clientId: 'client-ev-1',
      status: ConsultationStatus.CANCELLED,
    } as any);
    await service.checkVetDisconnectTimeout('cons-vet-to', new Date(Date.now() - 5 * 60 * 1000));
    expect(emittedRecords).toContainEqual({
      rooms: ['consultation:cons-vet-to', 'role:vets', 'user:client-ev-1'],
      event: 'consultation:cancelled',
      data: {
        consultationId: 'cons-vet-to',
        cancelledBy: 'SYSTEM_VET_DISCONNECT_TIMEOUT',
        status: ConsultationStatus.CANCELLED,
      },
    });
  });

  it('createPrescription emits prescription:new with petId and target rooms', async () => {
    const service = new PrescriptionsService();
    mockPrismaConsultation.findUnique.mockResolvedValue({
      id: 'cons-rx-1',
      clientId: 'client-ev-1',
      vetId: 'vet-ev-1',
      petId: 'pet-rx-1',
      status: ConsultationStatus.ACTIVE,
      deletedAt: null,
    } as any);
    mockPrismaPrescription.create.mockResolvedValue({
      id: 'rx-1',
      consultationId: 'cons-rx-1',
      vetId: 'vet-ev-1',
      medication: 'Amoxicilina',
      dosage: '1 tab',
      frequency: '12h',
      durationDays: 5,
      indications: 'Con comida',
      vet: { id: 'vet-ev-1', firstName: 'Carlos', lastName: 'Mendoza', licenseNumber: 'MP-1' },
      consultation: {
        clientId: 'client-ev-1',
        pet: { id: 'pet-rx-1', name: 'Milo' },
        client: { id: 'client-ev-1', firstName: 'Lucia', lastName: 'F', email: 'l@x.com' },
      },
    } as any);

    await service.createPrescription('cons-rx-1', vetUser, {
      medication: 'Amoxicilina',
      dosage: '1 tab',
      frequency: '12h',
      durationDays: 5,
      indications: 'Con comida',
    });

    expect(emittedRecords).toContainEqual({
      rooms: ['consultation:cons-rx-1', 'user:client-ev-1', 'user:vet-ev-1'],
      event: 'prescription:new',
      data: {
        consultationId: 'cons-rx-1',
        prescriptionId: 'rx-1',
        petId: 'pet-rx-1',
      },
    });
  });

  it('UsersService.updateProfile emits vet:presence ONLY for approved vets when isOnline is provided', async () => {
    const usersService = new UsersService();
    const now = new Date('2026-11-22T00:00:00.000Z');
    mockPrismaUser.update.mockResolvedValue({
      id: 'vet-ev-1',
      role: Role.VET,
      vetStatus: VetStatus.APPROVED,
      isOnline: false,
      lastSeen: now,
    } as any);

    await usersService.updateProfile('vet-ev-1', { isOnline: false });
    expect(emittedRecords).toContainEqual({
      rooms: 'role:vets',
      event: 'vet:presence',
      data: {
        vetId: 'vet-ev-1',
        isOnline: false,
        lastSeen: now.toISOString(),
      },
    });

    emittedRecords.length = 0;
    mockPrismaUser.update.mockResolvedValue({
      id: 'client-ev-1',
      role: Role.CLIENT,
      vetStatus: null,
      isOnline: false,
      lastSeen: now,
    } as any);
    await usersService.updateProfile('client-ev-1', { isOnline: false });
    expect(emittedRecords).toHaveLength(0);
  });

  it('remains non-blocking if io is undefined or io.to throws', async () => {
    activeMockIo = undefined;

    try {
      const consultationsService = new ConsultationsService();
      mockPrismaConsultation.findUnique.mockResolvedValue({
        id: 'cons-safe-1',
        clientId: 'client-ev-1',
        vetId: 'vet-ev-1',
        status: ConsultationStatus.ACTIVE,
        deletedAt: null,
      } as any);
      mockPrismaConsultation.update.mockResolvedValue({
        id: 'cons-safe-1',
        clientId: 'client-ev-1',
        vetId: 'vet-ev-1',
        status: ConsultationStatus.COMPLETED,
      } as any);

      await expect(
        consultationsService.completeConsultation('cons-safe-1', vetUser, {} as any)
      ).resolves.toMatchObject({ status: ConsultationStatus.COMPLETED });

      activeMockIo = {
        to: () => {
          throw new Error('Redis publish error');
        },
      };

      await expect(
        consultationsService.completeConsultation('cons-safe-1', vetUser, {} as any)
      ).resolves.toMatchObject({ status: ConsultationStatus.COMPLETED });
    } finally {
      activeMockIo = defaultMockIo;
    }
  });
});
