import { ConsultationStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { runTriageTimeoutSweep } from '../jobs/triageTimeout.sweeper';
import { captureTelemetryException } from '../lib/telemetry';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), updateMany: jest.fn() },
    consultationMetadata: { findMany: jest.fn() },
    consultationAuditLog: { create: jest.fn() },
  },
}));

jest.mock('../lib/redis', () => ({
  ...jest.requireActual('../lib/redis'),
  getRedisClient: jest.fn(() => null),
}));

describe('Triage Timeout Sweeper & Telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('expires stale waiting triage consultations while skipping scheduled appointments', async () => {
    const now = new Date('2026-11-27T18:00:00.000Z');
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      { id: 'stale-triage-1', notes: 'Vomitos', stateVersion: 1, activeDeviceId: null },
      { id: 'future-appt-1', notes: 'Control anual', stateVersion: 1, activeDeviceId: null },
    ]);
    (prisma.consultationMetadata.findMany as jest.Mock).mockResolvedValue([
      { consultationId: 'future-appt-1' },
    ]);
    (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.consultationAuditLog.create as jest.Mock).mockResolvedValue({ id: 'audit-sweep-1' });

    const count = await runTriageTimeoutSweep(now);

    expect(count).toBe(1);
    expect(prisma.consultation.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'stale-triage-1', status: ConsultationStatus.WAITING }),
      })
    );
  });

  it('never throws when captureTelemetryException is invoked without SENTRY_DSN', async () => {
    await expect(
      captureTelemetryException(new Error('Transient call failure'), { consultationId: 'c1' })
    ).resolves.toBeUndefined();
  });
});
