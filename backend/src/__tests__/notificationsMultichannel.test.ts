import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import app from '../app';
import prisma from '../lib/prisma';
import { notificationsScheduler } from '../jobs/notifications.scheduler';
import { emailService } from '../services/email.service';

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    notificationPreference: { findUnique: jest.fn(), upsert: jest.fn() },
    webPushSubscription: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn(), delete: jest.fn() },
    notification: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    pushToken: { findMany: jest.fn() },
    emailDispatchLog: { create: jest.fn(), delete: jest.fn(), findMany: jest.fn() },
    consultation: { findMany: jest.fn() },
    consultationMetadata: { findMany: jest.fn() },
    pet: { findMany: jest.fn() },
    petVaccine: { findMany: jest.fn() },
    followUp: { findMany: jest.fn(), update: jest.fn() },
  },
}));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-key-change-in-production-min-32-chars-long';

describe('Multichannel Notifications, Web Push Subscriptions & Deduplicated Scheduler', () => {
  const clientUser = {
    id: 'client-notif-1',
    email: 'tutor@huellicam.com',
    firstName: 'Sofía',
    lastName: 'Martínez',
    role: Role.CLIENT,
    vetStatus: null,
    deletedAt: null,
  };
  const token = jwt.sign({ userId: clientUser.id, role: Role.CLIENT }, JWT_SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads and updates notification preferences via GET/PUT /api/notifications/preferences', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(clientUser);
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue(null);

    const getRes = await request(app)
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.inAppEnabled).toBe(true);
    expect(getRes.body.data.pushEnabled).toBe(true);

    (prisma.notificationPreference.upsert as jest.Mock).mockResolvedValue({
      userId: clientUser.id,
      inAppEnabled: true,
      pushEnabled: false,
      emailRemindersEnabled: true,
      vaccineReminders: true,
      appointmentReminders: true,
      marketingEnabled: false,
    });

    const putRes = await request(app)
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ pushEnabled: false });

    expect(putRes.status).toBe(200);
    expect(putRes.body.data.pushEnabled).toBe(false);
  });

  it('registers and unsubscribes Web Push subscriptions cleanly', async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(clientUser);
    (prisma.webPushSubscription.upsert as jest.Mock).mockResolvedValue({
      id: 'sub-1',
      userId: clientUser.id,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    });

    const subRes = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'key-p256', auth: 'key-auth' },
      });

    expect(subRes.status).toBe(201);

    (prisma.webPushSubscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    const unsubRes = await request(app)
      .delete('/api/notifications/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });

    expect(unsubRes.status).toBe(200);
  });

  it('deduplicates email dispatch via unique insert lock BEFORE sending and dispatches vaccine reminders', async () => {
    const now = new Date('2026-12-01T12:00:00.000Z');
    const dueTomorrow = new Date('2026-12-02T12:00:00.000Z');

    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.pet.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.consultationMetadata.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.followUp.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.petVaccine.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'vac-due-1',
        name: 'Antirrábica',
        nextDueAt: dueTomorrow,
        pet: {
          id: 'pet-1',
          name: 'Milo',
          ownerId: clientUser.id,
          owner: { id: clientUser.id, email: clientUser.email, firstName: clientUser.firstName },
        },
      },
    ]);
    (prisma.notificationPreference.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.notification.create as jest.Mock).mockResolvedValue({ id: 'notif-vac-1' });
    (prisma.pushToken.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.webPushSubscription.findMany as jest.Mock).mockResolvedValue([]);

    // Simulate first call acquiring dedupe lock and second call hitting P2002 race
    (prisma.emailDispatchLog.create as jest.Mock)
      .mockResolvedValueOnce({ id: 'log-1' })
      .mockRejectedValueOnce(Object.assign(new Error('Unique violation'), { code: 'P2002' }));

    const sendSpy = jest.spyOn(emailService, 'sendReminderEmail').mockResolvedValue(true);

    await notificationsScheduler.runChecks(now);
    await notificationsScheduler.runChecks(now);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        to: clientUser.email,
        type: 'VACCINE',
      })
    );
    expect(prisma.notification.create).toHaveBeenCalled();

    sendSpy.mockRestore();
  });
});
