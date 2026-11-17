import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import api, { setMobileAuthToken } from '../lib/api';
import { resolveNotificationHref } from '../lib/deepLinks';
import { ApiResponse, BridgeSessionUser, Notification, Role } from '../types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export type BackendPushPlatform = 'ios' | 'android' | 'web';

export function toBackendPlatform(os: string): BackendPushPlatform | null {
  return os === 'ios' || os === 'android' || os === 'web' ? os : null;
}

let activeRole: Role = 'CLIENT';
let lastSyncedSessionKey: string | null = null;

export function getActiveSessionRole(): Role {
  return activeRole;
}

function getExpoProjectId(): string | undefined {
  const fromExpoConfig = Constants.expoConfig?.extra?.eas as
    | { projectId?: string }
    | undefined;
  const fromEasConfig = Constants.easConfig as { projectId?: string } | undefined;
  return fromEasConfig?.projectId || fromExpoConfig?.projectId;
}

const notificationsService = {
  async registerPushToken(): Promise<string | null> {
    const platform = toBackendPlatform(Platform.OS);
    if (!platform) return null;

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        return null;
      }

      const projectId = getExpoProjectId();
      const tokenData = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      );
      const token = tokenData.data;

      if (!token) return null;

      await api.post('/api/notifications/register-token', {
        token,
        platform,
      });

      return token;
    } catch (err) {
      // Safe fallback when Firebase google-services.json or network is unavailable.
      console.warn('Error registering push token:', err);
      return null;
    }
  },

  async syncSessionWithBackend(
    token: string | null,
    user?: BridgeSessionUser | null
  ): Promise<string | null> {
    if (!token || !user) {
      setMobileAuthToken(null);
      activeRole = 'CLIENT';
      lastSyncedSessionKey = null;
      return null;
    }

    activeRole = user.role;
    if (user.role === 'ADMIN') {
      setMobileAuthToken(null);
      lastSyncedSessionKey = null;
      return null;
    }

    const sessionKey = `${user.id}:${token}`;
    setMobileAuthToken(token);

    if (lastSyncedSessionKey === sessionKey) {
      return null;
    }
    lastSyncedSessionKey = sessionKey;

    return this.registerPushToken();
  },

  async fetchNotifications(): Promise<Notification[]> {
    const res = await api.get<ApiResponse<Notification[]>>('/api/notifications');
    return res.data.data || [];
  },

  async markAsRead(id: string): Promise<void> {
    await api.patch(`/api/notifications/${id}/read`);
  },

  async markAllAsRead(): Promise<void> {
    await api.patch('/api/notifications/read-all');
  },

  setupNotificationListeners(onNavigate: (href: string) => void): () => void {
    let handledColdId: string | null = null;

    const dispatch = (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) return;
      const identifier = response.notification.request.identifier;
      if (handledColdId !== null && identifier === handledColdId) return;

      const data = response.notification.request.content.data;
      const href = resolveNotificationHref(data, activeRole);
      if (href) {
        handledColdId = identifier;
        onNavigate(href);
      }
    };

    try {
      const initialResponse = Notifications.getLastNotificationResponse();
      if (initialResponse) {
        dispatch(initialResponse);
      }
    } catch {
      // Ignored in environments without getLastNotificationResponse support
    }

    const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
      dispatch(response);
    });

    return () => {
      responseListener.remove();
    };
  },
};

export default notificationsService;
