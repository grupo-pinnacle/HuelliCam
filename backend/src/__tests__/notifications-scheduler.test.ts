import prisma from '../lib/prisma';
import { emailService } from '../services/email.service';
import { NotificationsScheduler } from '../jobs/notifications.scheduler';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    consultation: {
      findMany: jest.fn(),
    },
    pet: {
      findMany: jest.fn(),
    },
    emailDispatchLog: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
  },
}));

jest.mock('../services/email.service', () => ({
  emailService: {
    sendReminderEmail: jest.fn(),
  },
}));

const mockConsultation = prisma.consultation as jest.Mocked<typeof prisma.consultation>;
const mockPet = prisma.pet as jest.Mocked<typeof prisma.pet>;
const mockLog = prisma.emailDispatchLog as jest.Mocked<typeof prisma.emailDispatchLog>;
const mockSendReminder = emailService.sendReminderEmail as jest.Mock;

describe('NotificationsScheduler (deduplicación y frecuencias)', () => {
  let scheduler: NotificationsScheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new NotificationsScheduler();
    mockSendReminder.mockResolvedValue(true);
    mockLog.create.mockResolvedValue({
      id: 'log-1',
      dedupeKey: 'key',
      type: 'APPOINTMENT',
      entityId: 'id',
      recipientEmail: 'tutor@test.com',
      sentAt: new Date(),
    });
  });

  it('checkUpcomingConsultations envía 1 vez y omite si ya existe dedupeKey en EmailDispatchLog', async () => {
    const now = new Date('2026-11-13T15:00:00.000Z');
    mockConsultation.findMany.mockResolvedValue([
      {
        id: 'cons-1',
        client: { email: 'tutor@test.com', firstName: 'Ana' },
        pet: { name: 'Firulais' },
      } as never,
      {
        id: 'cons-2',
        client: { email: 'otro@test.com', firstName: 'Luis' },
        pet: { name: 'Milo' },
      } as never,
    ]);

    mockLog.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'existing-log',
        dedupeKey: 'APPOINTMENT:cons-2',
        type: 'APPOINTMENT',
        entityId: 'cons-2',
        recipientEmail: 'otro@test.com',
        sentAt: now,
      });

    await scheduler.checkUpcomingConsultations(now);

    expect(mockSendReminder).toHaveBeenCalledTimes(1);
    expect(mockSendReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'tutor@test.com',
        type: 'APPOINTMENT',
      })
    );
    expect(mockLog.create).toHaveBeenCalledTimes(1);
    expect(mockLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dedupeKey: 'APPOINTMENT:cons-1',
        type: 'APPOINTMENT',
        entityId: 'cons-1',
      }),
    });
  });

  it('checkPreventiveCheckups filtra mascotas registradas >= 180 días y omite las ya notificadas en 180 días', async () => {
    const now = new Date('2026-11-13T15:00:00.000Z');
    mockPet.findMany.mockResolvedValue([
      {
        id: 'pet-due',
        name: 'Toby',
        owner: { email: 'toby@test.com', firstName: 'Carla' },
      } as never,
      {
        id: 'pet-recent-mail',
        name: 'Nala',
        owner: { email: 'nala@test.com', firstName: 'Pedro' },
      } as never,
    ]);

    mockLog.findMany.mockResolvedValue([
      { entityId: 'pet-recent-mail' } as never,
    ]);
    mockLog.findUnique.mockResolvedValue(null);

    await scheduler.checkPreventiveCheckups(now);

    expect(mockPet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { lte: expect.any(Date) },
        }),
      })
    );
    expect(mockSendReminder).toHaveBeenCalledTimes(1);
    expect(mockSendReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'toby@test.com',
        type: 'CHECKUP',
      })
    );
    expect(mockLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dedupeKey: 'CHECKUP:pet-due:2026-11-13',
        entityId: 'pet-due',
      }),
    });
  });

  it('checkPetBirthdays envía 1 saludo anual en la fecha de nacimiento (incluye 29-feb en año no bisiesto)', async () => {
    const now = new Date('2026-02-28T12:00:00.000Z'); // 2026 no es bisiesto
    mockPet.findMany.mockResolvedValue([
      {
        id: 'pet-leap',
        name: 'Bisi',
        birthDate: new Date('2024-02-29T12:00:00.000Z'),
        owner: { email: 'bisi@test.com', firstName: 'Sol' },
      } as never,
      {
        id: 'pet-newborn',
        name: 'Cachorro',
        birthDate: new Date('2026-02-28T12:00:00.000Z'), // age 0 -> omitir
        owner: { email: 'cachorro@test.com', firstName: 'Sol' },
      } as never,
      {
        id: 'pet-other-day',
        name: 'Max',
        birthDate: new Date('2023-06-10T12:00:00.000Z'),
        owner: { email: 'max@test.com', firstName: 'Leo' },
      } as never,
    ]);
    mockLog.findUnique.mockResolvedValue(null);

    await scheduler.checkPetBirthdays(now);

    expect(mockSendReminder).toHaveBeenCalledTimes(1);
    expect(mockSendReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'bisi@test.com',
        type: 'BIRTHDAY',
        title: '¡Feliz cumpleaños para Bisi!',
      })
    );
    expect(mockLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dedupeKey: 'BIRTHDAY:pet-leap:2026',
        type: 'BIRTHDAY',
        entityId: 'pet-leap',
      }),
    });
  });
});
