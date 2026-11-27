import { z } from 'zod';

export const registerPushTokenSchema = z.object({
  token: z.string().min(1, 'El token de notificacion es requerido'),
  platform: z.enum(['ios', 'android', 'web']),
});

export const updateNotificationPreferencesSchema = z.object({
  inAppEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  emailRemindersEnabled: z.boolean().optional(),
  vaccineReminders: z.boolean().optional(),
  appointmentReminders: z.boolean().optional(),
  marketingEnabled: z.boolean().optional(),
});

export const subscribeWebPushSchema = z.object({
  endpoint: z.string().url('Endpoint de suscripción inválido'),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(300).optional(),
});

export const unsubscribeWebPushSchema = z.object({
  endpoint: z.string().url('Endpoint inválido'),
});

export type RegisterPushTokenDTO = z.infer<typeof registerPushTokenSchema>;
export type UpdateNotificationPreferencesDTO = z.infer<typeof updateNotificationPreferencesSchema>;
export type SubscribeWebPushDTO = z.infer<typeof subscribeWebPushSchema>;
export type UnsubscribeWebPushDTO = z.infer<typeof unsubscribeWebPushSchema>;
