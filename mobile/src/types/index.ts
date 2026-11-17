export type Role = 'CLIENT' | 'VET' | 'ADMIN';
export type VetStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  role: Role;
  vetStatus?: VetStatus | null;
  licenseNumber?: string | null;
  bio?: string | null;
  photoUrl?: string | null;
  ratingAvg: number;
  ratingCount: number;
  isOnline: boolean;
  lastSeen?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeSessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, unknown> | null;
  isRead: boolean;
  readAt?: string | null;
  createdAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  timestamp: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: ApiError;
}

export type WebViewBridgeMessage =
  | { type: 'page:ready' }
  | { type: 'auth:session'; token: string; user: BridgeSessionUser }
  | { type: 'auth:logout' }
  | { type: 'wakelock:acquire' }
  | { type: 'wakelock:release' }
  | { type: 'call:ended' }
  | { type: 'print:request'; title: string; url: string; html?: string }
  | { type: 'external:open'; url: string };
