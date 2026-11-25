import axios from 'axios';

export const SECURE_STORE_REFRESH_KEY = 'huellicam_refresh_token';

const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001').trim();

export const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'X-Client-Platform': 'mobile',
  },
});

const createCorrelationId = (): string => {
  try {
    if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fallback below
  }
  return `mob_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const sessionCorrelationId = createCorrelationId();

api.interceptors.request.use((config) => {
  if (!config.headers['X-Request-Id'] && !config.headers['x-request-id']) {
    config.headers['X-Request-Id'] = createCorrelationId();
  }
  if (!config.headers['X-Correlation-Id'] && !config.headers['x-correlation-id']) {
    config.headers['X-Correlation-Id'] = sessionCorrelationId;
  }
  return config;
});

export function setMobileAuthToken(token: string | null): void {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

export default api;
