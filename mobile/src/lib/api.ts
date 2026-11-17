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

export function setMobileAuthToken(token: string | null): void {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

export default api;
