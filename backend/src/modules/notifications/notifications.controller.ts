import { Response, NextFunction } from 'express';
import { NotificationsService } from './notifications.service';
import {
  registerPushTokenSchema,
  subscribeWebPushSchema,
  unsubscribeWebPushSchema,
  updateNotificationPreferencesSchema,
} from './notifications.schemas';
import { AuthenticatedRequest } from '../auth/auth.middleware';

const notificationsService = new NotificationsService();

const getParamId = (param: string | string[]): string => (Array.isArray(param) ? param[0] : param);

export class NotificationsController {
  public getPreferences = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const prefs = await notificationsService.getPreferences(req.user!.id);
      res.status(200).json({ success: true, data: prefs });
    } catch (error) {
      next(error);
    }
  };

  public updatePreferences = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = updateNotificationPreferencesSchema.parse(req.body);
      const prefs = await notificationsService.updatePreferences(req.user!.id, validated);
      res.status(200).json({ success: true, data: prefs });
    } catch (error) {
      next(error);
    }
  };

  public getVapidPublicKey = async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const info = notificationsService.getVapidPublicKey();
      res.status(200).json({ success: true, data: info });
    } catch (error) {
      next(error);
    }
  };

  public subscribeWebPush = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = subscribeWebPushSchema.parse(req.body);
      const subscription = await notificationsService.subscribeWebPush(req.user!.id, validated);
      res.status(201).json({ success: true, data: subscription });
    } catch (error) {
      next(error);
    }
  };

  public unsubscribeWebPush = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = unsubscribeWebPushSchema.parse(req.body);
      await notificationsService.unsubscribeWebPush(req.user!.id, validated.endpoint);
      res.status(200).json({ success: true, message: 'Suscripción web push eliminada' });
    } catch (error) {
      next(error);
    }
  };

  public registerToken = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const validated = registerPushTokenSchema.parse(req.body);
      const pushToken = await notificationsService.registerPushToken(req.user!.id, validated);
      res.status(200).json({
        success: true,
        data: pushToken,
      });
    } catch (error) {
      next(error);
    }
  };

  public listMine = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const notifications = await notificationsService.getUserNotifications(req.user!.id);
      res.status(200).json({
        success: true,
        data: notifications,
      });
    } catch (error) {
      next(error);
    }
  };

  public markRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = getParamId(req.params.id);
      const notification = await notificationsService.markAsRead(id, req.user!.id);
      res.status(200).json({
        success: true,
        data: notification,
      });
    } catch (error) {
      next(error);
    }
  };

  public markAllRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await notificationsService.markAllAsRead(req.user!.id);
      res.status(200).json({
        success: true,
        message: 'Todas las notificaciones fueron marcadas como leidas',
      });
    } catch (error) {
      next(error);
    }
  };
}
