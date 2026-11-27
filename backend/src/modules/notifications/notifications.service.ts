import prisma, { isMissingTableError } from '../../lib/prisma';
import { AppError } from '../../middlewares/errorHandler';
import {
  RegisterPushTokenDTO,
  SubscribeWebPushDTO,
  UpdateNotificationPreferencesDTO,
} from './notifications.schemas';
import { io } from '../../realtime/socket.server';
import { logger, serializeError } from '../../lib/logger';
import { webPushService } from '../../services/webPush.service';

const DEFAULT_NOTIFICATION_PREFERENCES = {
  inAppEnabled: true,
  pushEnabled: true,
  emailRemindersEnabled: true,
  vaccineReminders: true,
  appointmentReminders: true,
  marketingEnabled: false,
};

export class NotificationsService {
  public async getPreferences(userId: string) {
    if (!prisma.notificationPreference?.findUnique) {
      return { userId, ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
    try {
      const existing = await prisma.notificationPreference.findUnique({ where: { userId } });
      return existing ?? { userId, ...DEFAULT_NOTIFICATION_PREFERENCES };
    } catch (err) {
      if (isMissingTableError(err)) {
        return { userId, ...DEFAULT_NOTIFICATION_PREFERENCES };
      }
      throw err;
    }
  }

  public async updatePreferences(userId: string, dto: UpdateNotificationPreferencesDTO) {
    return prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...dto,
      },
      update: dto,
    });
  }

  public getVapidPublicKey() {
    return {
      publicKey: webPushService.getPublicKey(),
      configured: webPushService.isConfigured(),
    };
  }

  public async subscribeWebPush(userId: string, dto: SubscribeWebPushDTO) {
    return prisma.webPushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: dto.userAgent || null,
      },
      update: {
        userId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: dto.userAgent || null,
      },
    });
  }

  public async unsubscribeWebPush(userId: string, endpoint: string) {
    return prisma.webPushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  public async registerPushToken(userId: string, dto: RegisterPushTokenDTO) {
    const pushToken = await prisma.pushToken.upsert({
      where: { token: dto.token },
      create: {
        userId,
        token: dto.token,
        platform: dto.platform,
      },
      update: {
        userId,
        platform: dto.platform,
      },
    });

    return pushToken;
  }

  public async getUserNotifications(userId: string) {
    return prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  public async markAsRead(notificationId: string, userId: string) {
    const notification = await prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new AppError('Notificacion no encontrada', 404, 'NOTIFICATION_NOT_FOUND');
    }

    return prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  public async markAllAsRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  public async createAndDispatch(
    userId: string,
    title: string,
    body: string,
    type: string,
    data?: Record<string, unknown>
  ) {
    const prefs = prisma.notificationPreference?.findUnique
      ? await prisma.notificationPreference.findUnique({ where: { userId } }).catch(() => null)
      : null;

    if (prefs && !prefs.inAppEnabled) {
      if (prefs.pushEnabled) {
        webPushService.sendToUser(userId).catch(() => {});
      }
      return { id: 'skipped-in-app', userId, title, body, type, skippedInApp: true };
    }

    // 1. Persist notification in database
    const notification = await prisma.notification.create({
      data: {
        userId,
        title,
        body,
        type,
        data: data ? (data as any) : undefined,
      },
    });

    // 2. Realtime socket emission if user is online
    if (io) {
      io.to(`user:${userId}`).emit('notification:new', notification);
    }

    // 3. Dispatch Web Push if enabled (respects NotificationPreference)
    if (!prefs || prefs.pushEnabled) {
      webPushService.sendToUser(userId).catch((err) => {
        logger.warn({ userId, err: serializeError(err) }, '[WebPush] Best-effort dispatch warning');
      });
    }

    // 4. Dispatch Expo Push Notification if user registered push tokens
    try {
      const pushTokens = prisma.pushToken?.findMany
        ? await prisma.pushToken.findMany({ where: { userId } })
        : [];

      const validTokens = pushTokens
        .map((t) => t.token)
        .filter((tok) => tok && tok.startsWith('ExponentPushToken'));

      if (validTokens.length > 0) {
        const messages = validTokens.map((token) => ({
          to: token,
          sound: 'default',
          title,
          body,
          data: {
            ...data,
            notificationId: notification.id,
            type,
          },
        }));

        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(messages),
        }).catch((err) => {
          logger.warn({ userId, err: serializeError(err) }, '[Push Dispatch] Error sending push to Expo');
        });
      }
    } catch (err) {
      logger.warn({ userId, err: serializeError(err) }, '[Push Dispatch] Error querying push tokens');
    }

    return notification;
  }
}

export const notificationsService = new NotificationsService();
