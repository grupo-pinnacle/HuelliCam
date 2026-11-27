# contracts

## Overview
Single source of truth for the consultation lifecycle contract shared by services, realtime gateways, and governance checks.

## Interface
- `[consultation.contract.ts:CLINICAL_CONSULTATION_STATUSES]` / `ClinicalConsultationStatus` - The 4 runtime states `WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`.
- `[consultation.contract.ts:ConsultationAuditEventType]`, `ConsultationAuditEntry` - Key audit events: `VET_ASSIGNED`, `DEVICE_HANDOFF`, `COMPLETED`, `CANCELLED`, `TIMEOUT_TRIAGE`, `TIMEOUT_VET_DISCONNECT`.
- `[consultation.contract.ts:SessionTerminationReason]` - `CONCURRENT_LOGIN`, `SESSION_MIGRATED_NEW_DEVICE`, `SESSION_REVOKED`, `ACCOUNT_BANNED`.
- `[consultation.contract.ts:extractDeviceId]`, `DEVICE_ID_REGEX` - Normalizes an `x-device-id` value; returns `undefined` unless it matches `/^[a-zA-Z0-9_-]{4,128}$/`.
- `[consultation.contract.ts:VET_DISCONNECT_GRACE_MS]`, `VET_DISCONNECT_SWEEP_BUFFER_MS`, `POST_CALL_DISCONNECT_GRACE_MS`, `POST_CALL_MIN_DURATION_SEC` - Timing constants (3 min, 500 ms, 30 min, 10 s).

## Global Invariants
- The PostgreSQL `ConsultationStatus` enum contains exactly the 4 canonical states; `scripts/verify-governance.js` check 5 fails if any of the 6 retired literals reappears in `backend/src` or `web/src`.
- Runtime code reads and writes only `CLINICAL_CONSULTATION_STATUSES`.
