import prisma from '../lib/prisma';
import { ConsultationsService } from '../modules/consultations/consultations.service';
import { callsService } from '../modules/calls/calls.service';
import { io } from '../realtime/socket.server';
import { evictUserRealtimeAndCall } from '../realtime/sessionEviction.helper';

jest.mock('../lib/prisma', () => {
  const auditLogs: Array<Record<string, unknown>> = [];
  return {
    __esModule: true,
    default: {
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
      $executeRaw: jest.fn().mockResolvedValue(1),
      consultation: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      consultationAuditLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          auditLogs.push(data);
          return { id: BigInt(auditLogs.length), ...data, createdAt: new Date() };
        }),
      },
      _auditLogs: auditLogs,
    },
  };
});

jest.mock('../modules/calls/calls.service', () => ({
  callsService: {
    removeParticipant: jest.fn().mockResolvedValue(undefined),
    deleteLiveKitRoom: jest.fn().mockResolvedValue(undefined),
    generateLiveKitToken: jest.fn(),
  },
}));

jest.mock('../realtime/socket.server', () => {
  const emittedEvents: { room: string | string[]; event: string; data: unknown }[] = [];
  const exceptMock = jest.fn(() => ({
    emit: jest.fn((event: string, data: unknown) => {
      emittedEvents.push({ room: 'except', event, data });
    }),
  }));

  const mockTo = jest.fn((room: string | string[]) => ({
    emit: jest.fn((event: string, data: unknown) => {
      emittedEvents.push({ room, event, data });
    }),
    except: exceptMock,
  }));

  const mockSockets = [{ data: { user: { id: 'tutor-1' } }, disconnect: jest.fn() }];
  const mockIn = jest.fn(() => ({
    fetchSockets: jest.fn().mockResolvedValue(mockSockets),
    disconnectSockets: jest.fn(),
    except: jest.fn(() => ({ disconnectSockets: jest.fn() })),
  }));

  return {
    io: {
      to: mockTo,
      in: mockIn,
      _emittedEvents: emittedEvents,
      _mockSockets: mockSockets,
    },
  };
});

describe('4-State Consultation Concurrency, Device Handoff & SFU Eviction', () => {
  const service = new ConsultationsService();
  const mockPrisma = prisma as unknown as {
    consultation: Record<string, jest.Mock>;
    consultationAuditLog: Record<string, jest.Mock>;
    _auditLogs: Array<Record<string, unknown>>;
  };
  const mockIo = io as unknown as {
    _emittedEvents: Array<{ room: string | string[]; event: string; data: unknown }>;
    _mockSockets: Array<{ disconnect: jest.Mock }>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma._auditLogs.length = 0;
    mockIo._emittedEvents.length = 0;
  });

  it('returns hasActiveConsultation=false when tutor has no WAITING/ACTIVE consultation', async () => {
    mockPrisma.consultation.findFirst.mockResolvedValue(null);

    const res = await service.handoffTutorDevice('tutor-idle', 'device-new-1');

    expect(res).toEqual({ hasActiveConsultation: false });
    expect(mockPrisma.consultation.updateMany).not.toHaveBeenCalled();
  });

  it('treats same-device reconnect as a no-op with 0 stateVersion bumps and 0 audit rows', async () => {
    mockPrisma.consultation.findFirst.mockResolvedValue({
      id: 'cons-same-1',
      clientId: 'tutor-1',
      vetId: 'vet-1',
      status: 'ACTIVE',
      activeDeviceId: 'device-A',
      stateVersion: 3,
    });

    const res = await service.handoffTutorDevice('tutor-1', 'device-A');

    expect(res).toEqual({
      hasActiveConsultation: true,
      didSwapDevice: false,
      consultationId: 'cons-same-1',
      vetId: 'vet-1',
      revokedDeviceId: null,
      status: 'ACTIVE',
      stateVersion: 3,
    });
    expect(mockPrisma.consultation.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.consultationAuditLog.create).not.toHaveBeenCalled();
  });

  it('swaps activeDeviceId via guarded CAS preserving WAITING/ACTIVE status and writes DEVICE_HANDOFF audit log', async () => {
    mockPrisma.consultation.findFirst.mockResolvedValue({
      id: 'cons-active-1',
      clientId: 'tutor-1',
      vetId: 'vet-1',
      status: 'ACTIVE',
      activeDeviceId: 'device-A',
      stateVersion: 2,
    });
    mockPrisma.consultation.updateMany.mockResolvedValue({ count: 1 });

    const res = await service.handoffTutorDevice('tutor-1', 'device-B');

    expect(res).toEqual({
      hasActiveConsultation: true,
      didSwapDevice: true,
      consultationId: 'cons-active-1',
      vetId: 'vet-1',
      revokedDeviceId: 'device-A',
      status: 'ACTIVE',
      stateVersion: 3,
    });
    expect(mockPrisma.consultation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'cons-active-1',
        clientId: 'tutor-1',
        status: 'ACTIVE',
        stateVersion: 2,
        deletedAt: null,
      },
      data: {
        activeDeviceId: 'device-B',
        stateVersion: 3,
      },
    });
    expect(mockPrisma.consultationAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consultationId: 'cons-active-1',
        eventType: 'DEVICE_HANDOFF',
        previousState: 'ACTIVE',
        newState: 'ACTIVE',
        actorId: 'tutor-1',
        deviceId: 'device-B',
        metadata: {
          revokedDeviceId: 'device-A',
          stateVersion: 3,
        },
      }),
    });
  });

  it('retries stateVersion CAS conflict cleanly (e.g. concurrent vet assignConsultation)', async () => {
    mockPrisma.consultation.findFirst
      .mockResolvedValueOnce({
        id: 'cons-comm-1',
        clientId: 'tutor-1',
        vetId: null,
        status: 'WAITING',
        activeDeviceId: 'device-A',
        stateVersion: 1,
      })
      .mockResolvedValueOnce({
        id: 'cons-comm-1',
        clientId: 'tutor-1',
        vetId: 'vet-1',
        status: 'ACTIVE',
        activeDeviceId: 'device-A',
        stateVersion: 2,
      });

    mockPrisma.consultation.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const res = await service.handoffTutorDevice('tutor-1', 'device-B');

    expect(res.hasActiveConsultation).toBe(true);
    expect(res.status).toBe('ACTIVE');
    expect(res.vetId).toBe('vet-1');
    expect(res.stateVersion).toBe(3);
    expect(mockPrisma.consultation.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.consultationAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('evictUserRealtimeAndCall emits auth:session_terminated and removes LiveKit participant', async () => {
    jest.useFakeTimers();
    try {
      await evictUserRealtimeAndCall({
        userId: 'tutor-1',
        role: 'CLIENT',
        reason: 'SESSION_MIGRATED_NEW_DEVICE',
        message: 'Tu consulta activa fue transferida a otro dispositivo.',
        consultationId: 'cons-evict-1',
        revokedDeviceId: 'device-A',
      });

      expect(mockIo._emittedEvents).toContainEqual({
        room: 'device:device-A',
        event: 'auth:session_terminated',
        data: {
          reason: 'SESSION_MIGRATED_NEW_DEVICE',
          message: 'Tu consulta activa fue transferida a otro dispositivo.',
          consultationId: 'cons-evict-1',
        },
      });
      expect(callsService.removeParticipant).toHaveBeenCalledWith(
        'cons-evict-1',
        'tutor_tutor-1:device-A'
      );

      jest.advanceTimersByTime(60);
      await Promise.resolve();
      expect(mockIo._mockSockets[0].disconnect).toHaveBeenCalledWith(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
