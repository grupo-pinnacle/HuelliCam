export const CLINICAL_CONSULTATION_STATUSES = [
  'WAITING',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;

export type ClinicalConsultationStatus = (typeof CLINICAL_CONSULTATION_STATUSES)[number];

export type ConsultationAuditEventType =
  | 'VET_ASSIGNED'
  | 'DEVICE_HANDOFF'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'TIMEOUT_TRIAGE'
  | 'TIMEOUT_VET_DISCONNECT'
  | 'CONSULTATION_RESCHEDULED'
  | 'CALL_INCIDENT'
  | 'CHAT_DELETED';

export interface ConsultationAuditEntry {
  consultationId: string;
  eventType: ConsultationAuditEventType;
  previousState: ClinicalConsultationStatus | string;
  newState: ClinicalConsultationStatus | string;
  actorId: string | null;
  deviceId?: string | null;
  metadata?: Record<string, unknown>;
}

export type SessionTerminationReason =
  | 'CONCURRENT_LOGIN'
  | 'SESSION_MIGRATED_NEW_DEVICE'
  | 'SESSION_REVOKED'
  | 'ACCOUNT_BANNED';

export const DEVICE_ID_REGEX = /^[a-zA-Z0-9_-]{4,128}$/;

export function extractDeviceId(raw: unknown): string | undefined {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== 'string') {
    return undefined;
  }
  const trimmed = candidate.trim();
  if (!trimmed || !DEVICE_ID_REGEX.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export const VET_DISCONNECT_GRACE_MS = 3 * 60 * 1000;
export const VET_DISCONNECT_SWEEP_BUFFER_MS = 500;
export const POST_CALL_DISCONNECT_GRACE_MS = 30 * 60 * 1000;
export const POST_CALL_MIN_DURATION_SEC = 10;
