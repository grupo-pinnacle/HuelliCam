import { Role, VetStatus } from '@prisma/client';
import {
  ClinicalConsultationStatus,
  SessionTerminationReason,
} from '../contracts/consultation.contract';

export interface SocketUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  tokenVersion: number;
  vetStatus?: VetStatus | null;
}

export interface SocketAckResponse<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface ClientToServerEvents {
  'join:consultation': (data: { consultationId: string }) => void;
  'message:send': (
    data: {
      consultationId: string;
      content: string;
      clientMsgId: string;
      attachmentUrl?: string;
    },
    callback?: (response: SocketAckResponse) => void
  ) => void;
  'call:answered': (data: { consultationId: string }) => void;
  'call:rejected': (data: { consultationId: string; reason?: string }) => void;
  'call:ended': (data: { consultationId: string }) => void;
  'leave:consultation': (data: { consultationId: string }) => void;
  'presence:heartbeat': (callback?: (ack: { ok: boolean; expiresAt?: number }) => void) => void;
}

export interface ServerToClientEvents {
  'message:new': (message: Record<string, unknown>) => void;
  'chat:deleted': (data: { consultationId: string; deletedBy?: string }) => void;
  'call:incoming': (data: { consultationId: string; callerName: string; roomName: string }) => void;
  'call:answered': (data: { consultationId: string }) => void;
  'call:rejected': (data: { consultationId: string; reason?: string }) => void;
  'call:ended': (data: { consultationId: string; endedBy?: string }) => void;
  'call:degraded': (data: {
    consultationId: string;
    errorCode?: string;
    reason?: string;
    reportedBy?: string;
    at?: string;
  }) => void;
  'prescription:new': (data: {
    consultationId: string;
    prescriptionId: string;
    petId: string;
  }) => void;
  'notification:new': (notification: Record<string, unknown>) => void;
  'consultation:new': (consultation: Record<string, unknown>) => void;
  'consultation:assigned': (data: {
    consultationId: string;
    vetId: string | null;
    clientId: string;
    status: ClinicalConsultationStatus | string;
  }) => void;
  'consultation:cancelled': (data: {
    consultationId: string;
    cancelledBy: string;
    status: ClinicalConsultationStatus | string;
  }) => void;
  'vet:presence': (data: {
    vetId: string;
    isOnline: boolean;
    lastSeen: string | null;
  }) => void;
  'auth:session_terminated': (data: {
    reason: SessionTerminationReason | string;
    message: string;
    consultationId?: string;
  }) => void;
  'session:invalidated': (data: {
    reason: string;
    consultationId?: string;
    message?: string;
  }) => void;
  'consultation:critical_resume': (data: {
    consultationId: string;
    status: ClinicalConsultationStatus | string;
    stateVersion: number;
    vetId?: string | null;
  }) => void;
  'consultation:tutor_reconnecting': (data: { consultationId: string; message: string }) => void;
  'consultation:tutor_reconnected': (data: { consultationId: string }) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  user: SocketUser;
  deviceId?: string;
  correlationId?: string;
}
