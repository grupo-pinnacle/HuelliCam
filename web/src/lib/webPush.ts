import api from '../services/api';
import type { ApiResponse } from '../types';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getNotificationPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function subscribeToWebPush(): Promise<{ subscribed: boolean; reason?: string }> {
  if (!isWebPushSupported()) {
    return { subscribed: false, reason: 'unsupported' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { subscribed: false, reason: permission };
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const json = existing.toJSON();
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      await api.post('/api/notifications/push/subscribe', {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        userAgent: navigator.userAgent,
      });
    }
    return { subscribed: true };
  }

  const keyRes = await api.get<ApiResponse<{ publicKey: string | null; configured: boolean }>>(
    '/api/notifications/push/vapid-public-key'
  );
  const publicKey = keyRes.data?.data?.publicKey;
  if (!publicKey) {
    return { subscribed: false, reason: 'vapid_unconfigured' };
  }

  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
  });

  const subJson = subscription.toJSON();
  if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
    return { subscribed: false, reason: 'invalid_subscription' };
  }

  await api.post('/api/notifications/push/subscribe', {
    endpoint: subJson.endpoint,
    keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
    userAgent: navigator.userAgent,
  });

  return { subscribed: true };
}

export async function unsubscribeFromWebPush(): Promise<void> {
  if (!isWebPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  await api
    .delete('/api/notifications/push/subscribe', {
      data: { endpoint: subscription.endpoint },
    })
    .catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}
