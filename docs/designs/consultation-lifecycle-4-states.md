# Consultation 4-State Lifecycle Simplification & Multi-Device Call Handoff

* **Author:** TodoTobi
* **Status:** Approved
* **Date:** 2026-11-26

--------------------------------------------------------------------------------

## Overview

Huellicam coordinates emergency veterinary triage and live video consultations across Express/Socket.IO (`backend/`), React portals (`web/`), LiveKit SFU media rooms, and Redis presence tracking. Over time, the platform accumulated two incompatible consultation state models: a 4-state clinical lifecycle (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`) used by core APIs and UI portals, and a 6-state concurrency/transport extension (`TRIAGE_CRITICAL_QUEUED`, `CLAIM_PENDING_SYNC`, `LIVEKIT_CONNECTING`, `IN_CALL_ACTIVE`, `AWAITING_EMERGENCY_CALLBACK`, `HANDOFF_IN_PROGRESS`) declared in PostgreSQL and an isolated `ConsultationConcurrencyService`.

This design standardizes `backend/` and `web/` onto the 4 clinical lifecycle states in this release without executing a destructive PostgreSQL enum DDL migration. Instead of overloading clinical status or persisting transient socket drops to PostgreSQL (`DisconnectQueue` and `Consultation.transportStatus`), real-time connectivity visibility moves to Redis `PresenceService`, Socket.IO presence events, and LiveKit room telemetry (`Call.status`). Emergency multi-device call handoff (`activeDeviceId` optimistic CAS with Socket.IO and LiveKit SFU eviction) is consolidated into `ConsultationsService`, `socket.server.ts`, and a shared `sessionEviction.helper.ts` module, hardened against identity hijacking and post-eviction termination races, and backed by atomic `ConsultationAuditLog` records restricted to lifecycle and device-handoff events.

--------------------------------------------------------------------------------

## Problem Statement

Keeping a split 10-state vs. 4-state model across storage, services, realtime gateways, and `web/` creates concrete reliability, security, and maintainability failures:

1. **Split-brain clinical state (`WAITING`/`ACTIVE` vs. 6 deprecated states)**:
   - Any consultation written into any of the 6 deprecated enum values (`TRIAGE_CRITICAL_QUEUED`, `CLAIM_PENDING_SYNC`, `LIVEKIT_CONNECTING`, `IN_CALL_ACTIVE`, `AWAITING_EMERGENCY_CALLBACK`, `HANDOFF_IN_PROGRESS`) disappears from vet queues (`GET /api/consultations/mine`), fails vet assignment (`PATCH /assign` returns `409`), fails clinical completion (`PATCH /complete` returns `400`), breaks duplicate consultation checks, skews `AdminService` metrics, renders as `"Cancelada"` in `web/` mappers (`ClientApp.tsx`, `vet/mappers.ts`), and blocks `CallRoom.tsx` from fetching LiveKit tokens (which requires `status === "ACTIVE"`).
   - Because production services never called `claimConsultationByVet` or `migrateTutorSession`, the runtime still carries dead concurrency scaffolding alongside unmigrated enum definitions.
2. **Duplicated concurrency service and split-brain transport state (`DisconnectQueue` vs. Redis `PresenceService`)**:
   - `ConsultationConcurrencyService` maintains parallel claim/migration paths (`claimConsultationByVet`, `migrateTutorSession`, `isConcurrencySchemaSupported`) that diverge from `ConsultationsService.assignConsultation` and `socket.server.ts` device handoff.
   - `DisconnectQueue` keeps debounce timers only in local Node process memory and queries/writes `Consultation.transportStatus` using conflicting literals (`'CONNECTED'`, `'ONLINE'`, `'GRACE_DISCONNECTED'`), omitting `'ACTIVE'` from `ACTIVE_CONCURRENCY_STATUSES`. Across multiple backend instances, reconnects on Instance B do not cancel timers on Instance A, marking connected tutors as disconnected in the database while emitting zero Socket.IO updates to veterinarians.
3. **Multi-device LiveKit SFU eviction and UI termination races**:
   - `CallsService.generateLiveKitToken` constructs `tutor_${userId}:${activeDeviceId}` from database state without validating the caller's `x-device-id` header, allowing stale or pre-handoff devices to mint tokens under the wrong device identity or omit device scoping.
   - `AuthController.login` emits `auth:session_terminated` without server-side socket disconnection or LiveKit SFU eviction, and `AuthService.logout`, `AdminService.banUser`, `AdminService.revokeUserSessionsAndSuspend`, `UsersService.changePassword`, and `PasswordResetService.resetPassword` revoke `tokenVersion` without removing active participants from LiveKit rooms, leaving up to a 15-minute ghost media window.
   - On an evicted device, LiveKit removal leaves `<LiveKitRoom>` mounted and triggers `CallRoom.tsx`'s 15-second disconnect timer, while manual or disconnect-triggered `handleFinalize()` attempts to call `PATCH /complete` (`403` for clients) and broadcasts `call:ended` (`chat.gateway.ts` relays it without role checks). Meanwhile, lazy-loaded `GlobalCallListener` can miss `consultation:critical_resume` on login, navigates without `?from=client`, and listens to non-existent `'call:cancelled'` instead of `'consultation:cancelled'`.
4. **Unsafe disconnect timeouts and inverted audit logging**:
   - Because `ACTIVE` covers both live video calls and post-call diagnosis writing, `checkVetDisconnectTimeout` can cancel an `ACTIVE` consultation 3 minutes after a vet disconnects even when the video call finished normally (`Call.status === 'ENDED'`), whereas an unbounded `ENDED` skip combined with a 1-active-per-tutor guard would deadlock tutors permanently if LiveKit `room_finished` fires after a vet crash.
   - `ConsultationAuditLog` records noisy `SOCKET_DISCONNECT` flaps from `DisconnectQueue` while recording nothing for `assign`, `complete`, `cancel`, timeout, or `WAITING`/`ACTIVE` device handoff transitions.

--------------------------------------------------------------------------------

## Goals

- **Canonical 4-state domain contract across `backend/` and `web/`**: Restrict all runtime writes, guards, metrics, schedulers, mappers, and UI filters to `WAITING`, `ACTIVE`, `COMPLETED`, and `CANCELLED`, executing a pre-deploy SQL backfill confirming zero legacy rows while keeping the PostgreSQL enum non-destructively intact and enforcing a static governance ban (`npm run check:governance`) across `backend/src/` and `web/src/`.
- **Single real-time connectivity plane**: Eliminate `DisconnectQueue`, in-process tutor disconnect debounce timers, and PostgreSQL `transportStatus` writes; use Redis `PresenceService` (atomic Lua connect/refresh/disconnect handling), Socket.IO events (`consultation:tutor_reconnecting`, `consultation:tutor_reconnected`), and `Call.status` as the authoritative source of connectivity and media state, removing disconnect DB writes and cluster `fetchSockets()` RPC broadcasts.
- **Race-free emergency multi-device handoff & unified SFU eviction**: Enforce atomic 1-active-per-tutor ownership and CAS `activeDeviceId` handoff inside `ConsultationsService`, validate `x-device-id` format across HTTP and Socket.IO, enforce device binding on LiveKit token issuance (`409 DEVICE_SESSION_STALE`), unify Socket.IO + SFU eviction across handoff, login, logout, admin ban/revocation, and password changes via `auth:session_terminated` and reactive `participant_joined` webhook eviction.
- **Role-safe `web/` `CallRoom` and call resumption**: Eagerly mount `GlobalCallListener` preserving `?from=client`, unmount `<LiveKitRoom>` and clear timers on eviction, prevent client-initiated `PATCH /complete` and room-ending `call:ended` broadcasts, remove unsafe 15-second auto-complete timers on transient WebRTC blips, and render live tutor-reconnection indicators for veterinarians.
- **Bounded post-call protection & distributed vet-disconnect tracking**: Persist 3-minute vet-disconnect deadlines in Redis sorted set `huellicam:vet_disconnect_deadlines` with atomic score-bump claiming, protect `ACTIVE` consultations for a bounded 30-minute post-call documentation window after a genuine ended call, consolidate `ConsultationConcurrencyService` out of existence, and record transactional `ConsultationAuditLog` entries for all 6 lifecycle and handoff events.

--------------------------------------------------------------------------------

## Non-Goals

- **Destructive PostgreSQL enum or column drops**: Dropping the 6 deprecated values from `ConsultationStatus` or removing `transport_status` / `User.isOnline` in PostgreSQL is excluded from this cycle to keep instant rollback safe; cleanup remains scheduled in Phase 2 after confirming zero legacy rows in production.
- **SMS or phone callback workflows**: Supporting `AWAITING_EMERGENCY_CALLBACK` or out-of-band PSTN callbacks is out of scope; disconnections recover inside the application.
- **Portal monolith refactors or new clinical tables**: Splitting `ClientApp.tsx` / `AdminApp.tsx` or migrating `localStorage`-only clinical sections into PostgreSQL is out of scope.
- **Expo `mobile/` WebView wrapper changes**: Modifying the `mobile/` codebase is deferred to a separate cycle; REST/Socket contracts (`x-device-id` backward compatibility when `activeDeviceId` is null, 4 clinical statuses) remain compatible.
- **Keeping `DISCONNECT_DEBOUNCE_MS` functional**: Retaining `DISCONNECT_DEBOUNCE_MS` in `backend/src/config/env.ts` as an unused `.env` variable is tolerated for deployment compatibility without preserving debounce behavior.

--------------------------------------------------------------------------------

## Critical User Journeys (CUJs)

### CUJ 1: Emergency Multi-Device Call Handoff & SFU Eviction

- **Given:** A tutor (pet owner / `CLIENT`) is authenticated on Device A with an `ACTIVE` or `WAITING` consultation whose `activeDeviceId` is `dev-A`, and Device A is connected to Socket.IO and the consultation's LiveKit room (`tutor_${userId}:dev-A`).
- **When:** The tutor logs into Huellicam on Device B (`x-device-id: dev-B`) and opens a WebSocket / `/call/:id?from=client`, triggering multi-device handoff.
- **Then:**
  - `ConsultationsService` updates `activeDeviceId` from `dev-A` to `dev-B` via optimistic CAS while keeping `status` as `ACTIVE` or `WAITING`, incrementing `stateVersion`, and recording a single `DEVICE_HANDOFF` entry in `ConsultationAuditLog`.
  - Device A receives `auth:session_terminated` (`reason: 'SESSION_MIGRATED_NEW_DEVICE'`), its Socket.IO connections close server-side, `<LiveKitRoom>` unmounts immediately without emitting `call:ended`, its stale `dev-A` token requests are rejected with `409 DEVICE_SESSION_STALE`, and `tutor_${userId}:dev-A` is removed from LiveKit SFU (with reactive eviction if `participant_joined` fires late).
  - Device B receives `consultation:critical_resume` on the eagerly loaded `GlobalCallListener` (with pull-based fallback from active consultations), preserves `?from=client`, mints a LiveKit token bound to `tutor_${userId}:dev-B`, and rejoins the veterinarian in the same consultation.

### CUJ 2: Tutor Transient Network Drop & Reconnect During an Active Consultation

- **Given:** A veterinarian is conducting an `ACTIVE` consultation with a tutor (`CLIENT`) inside `CallRoom.tsx`, and the tutor loses mobile connectivity on `dev-A` without switching devices.
- **When:** The tutor's Socket.IO connection drops (or presence TTL expires) and reconnects in-app on the same `dev-A`.
- **Then:**
  - Clinical `Consultation.status` remains `ACTIVE` throughout the outage; no row is mutated into an extended status, same-device reconnect bumps neither `stateVersion` nor `DEVICE_HANDOFF` audit logs, and no `SOCKET_DISCONNECT` row is written.
  - Redis `PresenceService` marks the tutor offline atomically once their last socket unregisters, and `socket.server.ts` notifies `user:${vetId}` and `consultation:${consultationId}` (`consultation:tutor_reconnecting`) so the veterinarian UI displays a tutor-reconnection banner and updates the status badge instead of `"Conexión estable"`.
  - When the tutor reconnects on `dev-A`, presence flips back online, `consultation:tutor_reconnected` clears the veterinarian indicator, and LiveKit/chat continue inside the same consultation.

### CUJ 3: Veterinarian Disconnect Grace Timeout vs. Bounded Post-Call Grace

- **Given:** An `ACTIVE` consultation has an assigned veterinarian whose Socket.IO connection disconnects unexpectedly.
- **When:** The 3-minute grace deadline expires in the distributed Redis `VetDisconnectTracker` sweeper and `checkVetDisconnectTimeout` runs.
- **Then:**
  - If Redis `PresenceService` shows the veterinarian reconnected on any backend instance within 3 minutes, the consultation remains `ACTIVE`.
  - If the latest video call ended intentionally (`Call.status === 'ENDED'`, duration above minimum threshold, and within a bounded 30-minute post-call grace window), the timeout skips cancellation so the veterinarian can complete clinical notes and prescriptions without losing work.
  - Otherwise (veterinarian remains offline and either the call never ended cleanly or the 30-minute post-call grace elapsed), guarded CAS transitions `status` from `ACTIVE` to `CANCELLED`, closes the LiveKit room, emits `consultation:cancelled`, and writes a single `TIMEOUT_VET_DISCONNECT` row in `ConsultationAuditLog`.

### CUJ 4: Pre-Deploy Backfill & Canonical 4-State Audit Trail

- **Given:** Historical database rows or cached pre-release `web/`/`mobile/` clients may temporarily hold deprecated status assumptions while PostgreSQL retains the 10-value enum.
- **When:** The pre-deploy SQL backfill runs before rollout and runtime endpoints process consultations thereafter.
- **Then:**
  - The idempotent SQL backfill migrates any deprecated rows (`vet_id IS NULL -> WAITING`, `vet_id IS NOT NULL -> ACTIVE`, recording `LEGACY_STATUS_BACKFILL` audit rows) and verifies `COUNT(*) = 0` for non-canonical statuses before deployment.
  - All `backend/` services, real-time gateways, and `web/` mappers persist and handle strictly `WAITING`, `ACTIVE`, `COMPLETED`, and `CANCELLED` (with non-terminal UI fallback in `web/` mappers if an unexpected string appears).
  - Every key clinical/handoff mutation (`VET_ASSIGNED`, `DEVICE_HANDOFF`, `COMPLETED`, `CANCELLED`, `TIMEOUT_TRIAGE`, `TIMEOUT_VET_DISCONNECT`) appends one structured `ConsultationAuditLog` record inside the same database transaction.

--------------------------------------------------------------------------------

## Proposed Architecture

### Core Decisions Integrated Prior to Blueprint

- **One active consultation per tutor (`clientId`)**: Enforced atomically inside a PostgreSQL transaction using an advisory lock so device handoff, duplicate triage checks, and `GlobalCallListener` resumption operate deterministically 1:1.
- **No Redis `active_consultation` shadow pointer**: Rather than maintaining a complex cache invalidated across 6+ write paths (especially since `socket.auth.middleware.ts` already queries `prisma.user` per handshake and `getMine` uses triage expiry), `CLIENT` connect/disconnect inspects PostgreSQL directly via the existing `(clientId, status, deletedAt)` index.
- **Pre-deploy backfill + 4-state runtime**: Keeping the 10-value enum non-destructively in PostgreSQL allows zero-DDL rollback while allowing runtime `backend/src/` and `web/src/` code to stay free of deprecated status literals (`check:governance` enforced).
- **Distributed `VetDisconnectTracker` in Redis ZSET**: Deadlines live in `huellicam:vet_disconnect_deadlines` with atomic score-bump claiming across backend instances, reconstructing `disconnectedAt` from the ZSET score and only using in-memory `.unref()` fallback timers when Redis is absent in local/test runs.

### 1. Canonical 4-State Contract & Pre-Deploy Expand–Contract Rollout

- **Domain contract boundary**: `backend/` exports `ClinicalConsultationStatus` (`WAITING | ACTIVE | COMPLETED | CANCELLED`), `ConsultationAuditEventType` (6 runtime events), `SessionTerminationReason`, and `x-device-id` regex validation; `web/` mirrors the 4 consultation statuses, widens `CallStatus` with `'FAILED'`, and adds concurrency metadata (`activeDeviceId`, `stateVersion`, `claimedAt`, `livekitRoomSid`) to `Consultation`.
- **Governance ban + SQL backfill**: `npm run check:governance` forbids deprecated status literals across `backend/src/` and `web/src/` outside the single contract module, while an idempotent SQL backfill migrates legacy rows ahead of code deployment.

### 2. Real-Time Connectivity Plane (Removing `DisconnectQueue` & `transportStatus` Writes)

- **Delete redundant transport persistence**: Remove `DisconnectQueue` and stop reading or writing `Consultation.transportStatus` across HTTP and Socket.IO gateways while leaving the database column untouched until Phase 2 cleanup.
- **Symmetric atomic Redis presence**: Upgrade both `PresenceService.unregisterSocketDisconnect` and `PresenceService.refreshSocketPresence` to atomic Redis Lua scripts (preserving pipeline fallback for mock test doubles), preventing cross-instance socket-resurrection or offline races.
- **Role-gated disconnect handling**: On `CLIENT` offline transitions during an `ACTIVE` consultation with an assigned vet, `socket.server.ts` emits `consultation:tutor_reconnecting` (and `consultation:tutor_reconnected` on subsequent socket online transition) using single deduplicated multi-room emits (`user:${vetId}`, `consultation:${consultationId}`).

### 3. Consolidated Multi-Device Handoff & Unified SFU Eviction

```mermaid
sequenceDiagram
    participant DevA as Device A (Stale)
    participant DevB as Device B (New)
    participant AuthWS as Auth / Socket.IO
    participant ConsSvc as ConsultationsService + DB
    participant SFU as LiveKit SFU + CallsService

    DevB->>AuthWS: POST /login or Socket.IO connect (x-device-id: dev-B)
    AuthWS->>ConsSvc: handoffTutorDevice(clientId, dev-B)
    ConsSvc->>ConsSvc: CAS updateMany (id, clientId, stateVersion) + DEVICE_HANDOFF AuditLog
    ConsSvc-->>AuthWS: consultationId, revokedDeviceId=dev-A, status, stateVersion
    AuthWS->>DevA: emit auth:session_terminated (SESSION_MIGRATED_NEW_DEVICE) + disconnect sockets
    AuthWS->>SFU: removeParticipant(consultationId, tutor_userId:dev-A)
    AuthWS->>DevB: emit consultation:critical_resume (and /mine pull fallback)
    DevB->>SFU: POST /api/calls/:id/token (x-device-id: dev-B)
    SFU-->>DevB: LiveKit JWT sub=tutor_userId:dev-B
    Note over DevA,SFU: Stale dev-A /token -> 409 DEVICE_SESSION_STALE; late participant_joined evicts dev-A
```

- **Device-bound LiveKit token minting & webhook defense**: `CallsController.getToken` passes validated `x-device-id` to `CallsService.generateLiveKitToken`. When `activeDeviceId` is set, mismatches (including missing headers) fail with `409 DEVICE_SESSION_STALE`; when null and `x-device-id` is supplied, atomic CAS binds `activeDeviceId` before issuing `tutor_${user.id}:${activeDeviceId}` (preserving bare `user.id` compatibility only when both `activeDeviceId` and `x-device-id` are null). `CallsService.handleWebhook` (`participant_joined`) validates participant identity against the consultation's `activeDeviceId` regardless of `Call.status` and evicts stale compound or legacy identities asynchronously.
- **Unified eviction helper**: One shared helper (`evictUserRealtimeAndCall`) handles Socket.IO termination (`auth:session_terminated` + server-side socket disconnect) and best-effort LiveKit participant eviction across `handoffTutorDevice`, `AuthController.login`, `AuthService.logout`, `AdminService.banUser`, `AdminService.revokeUserSessionsAndSuspend`, `UsersService.changePassword`, and `PasswordResetService.resetPassword`.
- **Frontend (`web/`) alignment**: `GlobalCallListener` loads eagerly with `?from=client` parity in both `handleCriticalResume` and `handleAccept` (listening to `'consultation:cancelled'`). `CallRoom.tsx` unmounts `<LiveKitRoom>` on `huellicam:session_terminated`, maps `409 DEVICE_SESSION_STALE` to session termination UX, disables 15-second auto-complete timers for both roles, keeps client manual exits local (blocking `/complete` and `call:ended`), clamps elapsed clocks from `startedAt`, and displays non-blocking tutor reconnection indicators alongside `Consultations.tsx`. `chat.gateway.ts` limits `call:ended` broadcasts to `VET` and `ADMIN`.

### 4. Guarded Clinical Transitions, Distributed Vet-Disconnect Sweeper & Audit Ownership

- **Guarded clinical CAS transitions**: Wrap `assignConsultation`, `completeConsultation`, `cancelConsultation`, `checkTriageTimeout`, `checkVetDisconnectTimeout`, and `getMine` batch expiry (`findMany` + per-row `checkTriageTimeout`) in optimistic `updateMany` CAS inside `prisma.$transaction`, recording `VET_ASSIGNED`, `COMPLETED`, `CANCELLED`, `TIMEOUT_TRIAGE`, and `TIMEOUT_VET_DISCONNECT` inside `ConsultationsService`.
- **Distributed `VetDisconnectTracker`**: Persist vet disconnect deadlines in Redis sorted set `huellicam:vet_disconnect_deadlines` with atomic Lua score-bump claiming (`WITHSCORES`), reconstructing `disconnectedAt` from the score (`score - graceMs`), canceling across instances on reconnect, and stopping the sweeper interval cleanly before closing Redis during graceful shutdown.

--------------------------------------------------------------------------------

## Non-Functional Requirements

- **Security & Privacy**: Regex-validating `x-device-id` (`/^[a-zA-Z0-9_-]{4,128}$/`) prevents colon-delimited identity injection in `tutor_${userId}:${deviceId}`. Binding token issuance to `activeDeviceId` (`409 DEVICE_SESSION_STALE`), unmounting `<LiveKitRoom>` on eviction, and triggering SFU eviction on all `tokenVersion` rotation paths closes the 15-minute ghost media window while retaining strict PII redaction (`email`, `phone`) on `WAITING` queue payloads.
- **Performance & Latency**: Removing `DisconnectQueue`, in-process debounce state, PostgreSQL `transportStatus` writes, and cluster-wide `fetchSockets()` broadcasts removes all disconnect-path DB write storms and Pub/Sub RPC scans. Atomic Lua presence scripts execute in one Redis round-trip (`O(log N + M)` per user socket set where `M` is pruned stale sockets).
- **Rollout & Rollback**: Leaving the 10-value `ConsultationStatus` enum and `transport_status` column intact in PostgreSQL allows application code rollback without destructive database DDL, backed by an idempotent pre-deploy SQL backfill verified with `COUNT(*) = 0`.

--------------------------------------------------------------------------------

## Risks & Mitigations

| Risk / Failure Mode | Impact | Mitigation |
|---|---|---|
| LiveKit `room_finished` fires after vet crash + tutor exit (`Call.status = 'ENDED'`) | Would skip `checkVetDisconnectTimeout` indefinitely and permanently lock the tutor out under 1-active-per-tutor | Inspect only the latest `Call`; require `status === 'ENDED'`, `durationSeconds >= 10`, and bounded `< 30 min` post-call elapsed window before skipping cancellation. |
| Concurrent `POST /api/consultations` requests from same tutor | Duplicate `WAITING` rows would break 1:1 `handoffTutorDevice` assumptions | Serialize creation per `clientId` inside `prisma.$transaction` using `pg_advisory_xact_lock(hashtext(clientId))`. |
| Redis unavailable or claiming backend pod crashes mid-sweep | Vet-disconnect grace timeout could stall or drop | Claim deadlines with a 60s score-bump (`ZADD`) instead of destructive `ZREM` until completion; retain in-memory `.unref()` fallback in dev/test; require Redis in production startup (`socket.server.ts`). |
| LiveKit SFU `removeParticipant` fails transiently or device joins late | Revoked device stays in media room briefly | Treat `404`/not-found gracefully, unmount `<LiveKitRoom>` client-side on `huellicam:session_terminated`, and enforce reactive identity check in `CallsService.handleWebhook` (`participant_joined`). |
| Pre-deploy SQL backfill detects >0 legacy rows or pre-existing duplicate open consultations per `clientId` | Startup queries or 1-active-per-tutor invariants could mismatch | Execute idempotent pre-deploy backfill SQL (`COUNT(*) = 0`) and duplicate triage resolution before deploying updated code; non-destructive enum allows safe rollback. |

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: Wire all 6 extended `ConsultationStatus` values end-to-end across `backend/` and `web/`

- **Pros:** Uses all enum members already declared in [schema.prisma](../../backend/prisma/schema.prisma#L23-L34) and avoids leaving deprecated enum members unused in PostgreSQL.
- **Cons:** Conflates clinical consultation lifecycle (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`) with transient WebSocket and LiveKit connectivity; breaks active `web/` mappers ([ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L111), [mappers.ts](../../web/src/vet/mappers.ts#L118-L121)), `CallRoom` LiveKit token fetching ([CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L1142)), `AdminService` metrics, and `ConsultationsService` guards; adds 10-state branching complexity for unused workflows such as `AWAITING_EMERGENCY_CALLBACK`.
- **Reason for Rejection:** Clinical status must remain decoupled from transport state, and Huellicam does not support telephone/SMS emergency callbacks.

### Alternative B: Keep `Consultation.transportStatus` in PostgreSQL + in-memory `DisconnectQueue` alongside Redis `PresenceService`

- **Pros:** Preserves `ConsultationConcurrencyService` and `DisconnectQueue` structure with minimal refactoring.
- **Cons:** Stores disconnect timers in process memory (breaking multi-instance cancellation when a tutor reconnects on another instance), maintains conflicting literal strings (`'OFFLINE'`, `'CONNECTED'`, `'ONLINE'`, `'GRACE_DISCONNECTED'`), omits `'ACTIVE'` in `ACTIVE_CONCURRENCY_STATUSES`, and triggers PostgreSQL transactions plus cluster-wide `fetchSockets()` broadcasts on disconnect storms while zero callers read `transportStatus`.
- **Reason for Rejection:** Causes cross-instance split-brain timers and reconnect DB/RPC storms when Redis `PresenceService` and LiveKit webhooks already provide real-time connectivity.

### Alternative C: Drop the 6 deprecated enum values immediately via a destructive Prisma migration

- **Pros:** Eliminates deprecated values from `@prisma/client` and PostgreSQL immediately without requiring a pre-deploy backfill phase.
- **Cons:** Recreating a PostgreSQL enum under live traffic complicates zero-downtime rollout and blocks quick application rollback if an unmigrated row or pre-release client exists.
- **Reason for Rejection:** An expand–contract rollout with compile-time 4-state narrowing and an idempotent pre-deploy backfill removes runtime writes first while deferring enum DDL risk until zero legacy rows remain.

### Alternative D: Disable live multi-device call handoff and force full re-login / new consultation on device switch

- **Pros:** Eliminates device handoff transactions, eviction signaling, and LiveKit participant removal logic.
- **Cons:** Forces tutors to abandon an ongoing emergency consultation and rejoin triage from scratch if their battery dies or they switch devices mid-call.
- **Reason for Rejection:** Preserving CAS `activeDeviceId` handoff with LiveKit SFU eviction maintains emergency care continuity while closing identity-hijack and duplicate-stream risks.

### Alternative E: Allow multiple concurrent active consultations per tutor (`petId`-scoped)

- **Pros:** Lets a single owner keep separate concurrent open consultations for multiple pets at the same time.
- **Cons:** Either couples unrelated pet rooms onto one `activeDeviceId` or breaks proactive `GlobalCallListener` resumption at login until the user navigates manually to a specific `/call/:id` route.
- **Reason for Rejection:** Enforcing at most one active consultation (`WAITING` or `ACTIVE`) per `clientId` guarantees deterministic 1:1 device ownership and `GlobalCallListener` resumption.

--------------------------------------------------------------------------------

## Additional Resources

- [backend-audit.md](../audits/backend-audit.md) (§2.1, §2.4, §3.3)
- [web-audit.md](../audits/web-audit.md) (§1.2, §1.4, §2.1, §4 Cross-Contract Matrix)
- [SPEC.md](../SPEC.md), [TECH_REFERENCE.md](../TECH_REFERENCE.md), [DECISIONS.md](../DECISIONS.md) (ADR-004, ADR-008, ADR-009, ADR-024)

--------------------------------------------------------------------------------

## Future Improvements

- **Phase 2 Schema Cleanup Migration**: After verifying `COUNT(*) = 0` for the 6 deprecated `ConsultationStatus` values and zero dependencies on `transport_status` or `User.isOnline` across at least one release cycle, execute a Prisma migration dropping the 6 unused enum labels and removing `transport_status` / `User.isOnline` columns.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Phase 1: Backend Contracts, Presence Lua, Distributed Tracker & Eviction Helper

#### 1. `backend/src/contracts/consultation.contract.ts` (Create)
- **Type / Scope:** Pure TypeScript Domain Contract
- **Proposed Changes:** Export `CLINICAL_CONSULTATION_STATUSES = ['WAITING', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const`, `type ClinicalConsultationStatus`, `DEPRECATED_CONSULTATION_STATUSES`, `type ConsultationAuditEventType = 'VET_ASSIGNED' | 'DEVICE_HANDOFF' | 'COMPLETED' | 'CANCELLED' | 'TIMEOUT_TRIAGE' | 'TIMEOUT_VET_DISCONNECT'`, `interface ConsultationAuditEntry` (`actorId: string | null`, `deviceId?: string | null`, `metadata?: Record<string, unknown>`), `type SessionTerminationReason = 'CONCURRENT_LOGIN' | 'SESSION_MIGRATED_NEW_DEVICE' | 'SESSION_REVOKED' | 'ACCOUNT_BANNED'`, `DEVICE_ID_REGEX = /^[a-zA-Z0-9_-]{4,128}$/`, `extractDeviceId(raw: unknown): string | undefined`, `VET_DISCONNECT_GRACE_MS = 180_000`, `VET_DISCONNECT_SWEEP_BUFFER_MS = 500`, `POST_CALL_DISCONNECT_GRACE_MS = 1_800_000`, and `POST_CALL_MIN_DURATION_SEC = 10`.

#### 2. `backend/src/realtime/sessionEviction.helper.ts` (Create)
- **Type / Scope:** Unified Socket.IO & LiveKit SFU Eviction Helper
- **Proposed Changes:** Export `evictUserRealtimeAndCall({ userId, role, reason, message, consultationId, revokedDeviceId, excludeDeviceId, emitEvent })`. When `emitEvent !== false`, emit `'auth:session_terminated'` to `device:${revokedDeviceId}` (or `user:${userId}` excluding `device:${excludeDeviceId}` when set) and disconnect matching sockets server-side after a 50ms flush timer `.unref()`. Perform single-shot best-effort `callsService.removeParticipant` for active consultations (covering `tutor_${userId}:${deviceId}` when present plus legacy bare `userId` for `VET` or legacy `CLIENT` sessions), logging outcome with `consultationId`, `userId`, `revokedDeviceId`, and `reason`.

#### 3. `backend/src/realtime/presence.service.ts` (Modify)
- **Type / Scope:** Distributed Presence Service
- **Proposed Changes:** Implement atomic `UNREGISTER_SOCKET_DISCONNECT_LUA` and `REFRESH_SOCKET_PRESENCE_LUA` scripts (`ZREM`/`ZREMRANGEBYSCORE`/`ZCARD`/`ZADD`/`SET`), guarded by `typeof redis.eval === 'function'` so existing `redis.pipeline()` test mocks (`InMemoryRedisMock`) keep functioning cleanly.

#### 4. `backend/src/realtime/vetDisconnectTracker.ts` (Modify)
- **Type / Scope:** Distributed Vet Disconnect Grace Tracker
- **Proposed Changes:** Store vet deadlines in Redis ZSET `huellicam:vet_disconnect_deadlines` (`ZADD` with `now + VET_DISCONNECT_GRACE_MS + VET_DISCONNECT_SWEEP_BUFFER_MS`; `ZREM` on reconnect). Export `CLAIM_EXPIRED_VET_DEADLINES_LUA` (`ZRANGEBYSCORE ... WITHSCORES LIMIT 0 50` + 60s score-bump claim). Expose `start()`, `stop()`, `clear()` (clears fallback timers and calls `stop()`), async `schedule(vetId, disconnectedAt?)`, async `cancel(vetId)`, and `sweepExpiredOnce(now?)` (reconstructing `disconnectedAt = new Date(score - this.graceMs)` and calling `ZREM` post-completion). Retain in-memory `.unref()` fallback only when Redis is absent, and query `status: 'ACTIVE'`.

#### 5. `backend/src/realtime/socket.types.ts` (Modify)
- **Type / Scope:** Socket.IO Typed Event Contract
- **Proposed Changes:** Narrow consultation statuses to `ClinicalConsultationStatus`; add `'consultation:tutor_reconnected': (data: { consultationId: string }) => void`; type `'auth:session_terminated'` with `SessionTerminationReason`; add `message?: string` to `'session:invalidated'` for rolling-deploy compatibility; replace `any` in message/notification/consultation event types with `Record<string, unknown>` / `unknown`.

* **Phase 1 Checkpoint:** `npm run typecheck -w backend` (0 errors).

---

### Phase 2: Backend Services Consolidation, Legacy Removal & Tests

#### 6. `backend/src/modules/consultations/consultations.service.ts` & `consultations.controller.ts` (Modify)
- **Type / Scope:** Core Consultation Service & Controller
- **Proposed Changes:**
  - Export `export const consultationsService = new ConsultationsService()` and reuse `callsService` singleton; add private `recordConsultationAudit(tx, entry)` inside `ConsultationsService`.
  - In `createConsultation`: wrap duplicate check (`{ clientId, status: { in: ['WAITING', 'ACTIVE'] }, deletedAt: null }`, `orderBy: { createdAt: 'desc' }`) + `checkTriageTimeout` + `create` inside `prisma.$transaction` with `pg_advisory_xact_lock(hashtext(clientId))`; validate `activeDeviceId` via `extractDeviceId` without writing `transportStatus`.
  - Add `handoffTutorDevice(clientId, newDeviceId)`: retry up to 2 times on `stateVersion` conflict; treat `activeDeviceId === newDeviceId` as a no-op (0 stateVersion bumps, 0 audit writes); swap `activeDeviceId` via guarded CAS inside `$transaction` and record `DEVICE_HANDOFF`.
  - Wrap `assignConsultation` (setting `claimedAt: new Date()`), `completeConsultation`, `cancelConsultation`, `checkTriageTimeout`, `checkVetDisconnectTimeout` in CAS `updateMany` inside `$transaction`, recording `ConsultationAuditLog` rows (`actorId: null` for system timeouts). Guard `checkVetDisconnectTimeout` against online vet presence AND latest `Call` (`orderBy: { createdAt: 'desc' }` with `status === 'ENDED' && durationSeconds >= 10 && age < 30m`). Update `getMine` batch triage expiry to bounded `findMany` + per-row `checkTriageTimeout`.
  - In `consultations.controller.ts`, import shared `extractDeviceId` and `consultationsService`.

#### 7. `backend/src/modules/calls/calls.controller.ts` & `calls.service.ts` (Modify)
- **Type / Scope:** LiveKit Token Issuance & Webhook Defense
- **Proposed Changes:**
  - Extract validated `x-device-id` in `CallsController.getToken` (reusing `callsService` singleton) and pass to `generateLiveKitToken`.
  - Restrict `CALLABLE_CONSULTATION_STATUSES` to `[ConsultationStatus.ACTIVE]`.
  - Implement 2×2 `isClient` matrix in `generateLiveKitToken`: null+no-header -> `user.id` compatibility; null+header -> CAS `activeDeviceId` bind (`409 DEVICE_SESSION_STALE` on `count === 0` mismatch) and mint `tutor_${user.id}:${deviceId}`; non-null+match -> mint `tutor_${user.id}:${activeDeviceId}`; non-null+mismatch/missing -> `409 DEVICE_SESSION_STALE`.
  - In `handleWebhook` (`participant_joined`), check `Consultation.activeDeviceId` before early `ENDED` return and evict stale `tutor_${clientId}:${deviceId}` or bare `clientId` participants asynchronously via `removeParticipant`.

#### 8. `backend/src/realtime/socket.auth.middleware.ts` & `backend/src/realtime/gateways/chat.gateway.ts` (Modify)
- **Type / Scope:** WS Auth Validation & Chat Gateway Authorization
- **Proposed Changes:** Enforce `extractDeviceId` in `socketAuthMiddleware` so `socket.data.deviceId` matches `DEVICE_ID_REGEX`. Restrict `call:ended` relay in `chat.gateway.ts` strictly to `VET` and `ADMIN`.

#### 9. `backend/src/realtime/socket.server.ts` & `backend/src/server.ts` (Modify)
- **Type / Scope:** Socket.IO Gateway & Graceful Shutdown
- **Proposed Changes:**
  - Remove `consultationConcurrencyService`, `disconnectQueue`, `evictRevokedSessionAndResume`, `deviceConnectionEpoch`, `activeLocalDeviceSockets`, and `fetchSockets()` disconnect scans.
  - On `CLIENT` connect with `deviceId`, run `consultationsService.handoffTutorDevice`; invoke `evictUserRealtimeAndCall` on device swap; emit `consultation:critical_resume` to `device:${deviceId}`; emit `consultation:tutor_reconnected` via deduplicated `io.to([`user:${vetId}`, `consultation:${consultationId}`])` when `ACTIVE`.
  - On `CLIENT` offline (`wentOffline === true`), query indexed `ACTIVE` consultation and emit `consultation:tutor_reconnecting` to `[user:${vetId}, consultation:${consultationId}]`.
  - On `VET` connect/offline, await/fire `vetDisconnectTracker.cancel` / `.schedule`.
  - In `server.ts`, remove `disconnectQueue`, start `vetDisconnectTracker.start()` when `NODE_ENV !== 'test'`, and keep `vetDisconnectTracker.clear()` before `closeAllRedisClients()`.

#### 10. `backend/src/modules/auth/auth.controller.ts`, `auth.service.ts`, `admin/admin.service.ts`, `users/users.service.ts`, `auth/passwordReset.service.ts` (Modify)
- **Type / Scope:** Session & Token Revocation Callers
- **Proposed Changes:** Wire `handoffTutorDevice` (for `CLIENT` logins with `x-device-id`) + `evictUserRealtimeAndCall` into `AuthController.login`, `AuthService.logout`, `AdminService.banUser`, `AdminService.revokeUserSessionsAndSuspend`, `UsersService.changePassword`, and `PasswordResetService.resetPassword`.

#### 11. Delete Legacy Backend Modules & Tests (Delete / Modify / Create)
- **Delete:** `backend/src/modules/consultations/consultationConcurrency.service.ts`, `backend/src/realtime/disconnectQueue.ts`, `backend/src/__tests__/disconnectQueue.test.ts`, `backend/src/__tests__/realtime.disconnectQueue.test.ts`.
- **Create:** `backend/src/__tests__/vetDisconnectTracker.test.ts`.
- **Modify:** `backend/src/__tests__/consultationConcurrency.test.ts`, `backend/src/__tests__/consultations.test.ts`, `backend/src/__tests__/calls.test.ts`, `backend/src/__tests__/presence.test.ts`, `backend/src/__tests__/auth.test.ts`, and any other test suite referencing deleted symbols.

* **Phase 2 Checkpoint:** `npm run typecheck -w backend && npm test -w backend -- --watchAll=false` (0 errors, 0 failures).

---

### Phase 3: Web Client Alignment & Tests

#### 12. `web/src/types/index.ts`, `web/src/App.tsx`, `web/src/components/call/GlobalCallListener.tsx` (Modify)
- **Type / Scope:** Frontend Contracts & Eager Resume Listener
- **Proposed Changes:** Narrow `ConsultationStatus` to 4 states, add `'FAILED'` to `CallStatus`, and add concurrency fields to `Consultation`. Import `GlobalCallListener` eagerly in `App.tsx` (removing `<Suspense fallback={null}>`). In `GlobalCallListener.tsx`, import `useAuth()`, preserve `?from=client` in both `handleCriticalResume` and `handleAccept` for `CLIENT`, guard `/assign` for non-`CLIENT`, and replace `'call:cancelled'` with `'consultation:cancelled'`.

#### 13. `web/src/context/SocketContext.tsx` & `web/src/components/common/SessionTerminatedModal.tsx` (Modify)
- **Type / Scope:** Realtime Presence State & Eviction UX
- **Proposed Changes:** Fix `VetPresencePayload.lastSeen?: string | null`; add `reconnectingConsultations: Record<string, string>` to `SocketContextValue` / `NOOP_SOCKET_CONTEXT` updated by `consultation:tutor_reconnecting` and cleared by `consultation:tutor_reconnected`, `consultation:cancelled`, `call:ended`, disconnect, and user change; change `handleSessionInvalidated` default reason to `'SESSION_MIGRATED_NEW_DEVICE'`. Update `SessionTerminatedModal.tsx` with explicit handoff title and copy for `SESSION_MIGRATED_NEW_DEVICE`.

#### 14. `web/src/vet/CallRoom.tsx`, `web/src/vet/mappers.ts`, `web/src/vet/Consultations.tsx`, `web/src/pages/ClientApp.tsx`, `web/src/pages/AdminApp.tsx` (Modify)
- **Type / Scope:** Call Room Isolation, Clocks, Banners & Portals
- **Proposed Changes:**
  - `CallRoom.tsx`: Remove deprecated status checks; on `huellicam:session_terminated`, set `evictedRef`, clear timer, and unmount `<LiveKitRoom>` (`setLivekitToken(null)`); remove 15s auto-finalize timer on `onDisconnected` for both roles; make `fromClient` manual exit local without `/complete` or `call:ended`; map `409 DEVICE_SESSION_STALE` to `huellicam:session_terminated`; reset `livekitToken` and `livekitFailed` on `consultation:critical_resume`; clamp `secs` from `consultation.startedAt` (frozen at `endedAt`, `0`-based while waiting); render `data-testid="tutor-reconnecting-banner"` (`"El tutor está reconectando…"`) and status label for `!fromClient` when `reconnectingConsultations?.[id]` is active.
  - `mappers.ts` & `ClientApp.tsx`: Explicit 4-state mapping with non-terminal fallback (`c.vetId ? 'Activa' : 'Próxima'` / `'Confirmada' : 'Pendiente'`) instead of defaulting to `'Cancelada'`.
  - `AdminApp.tsx` & `Consultations.tsx`: Use shared `ConsultationStatus` in `AdminApp.tsx:80`; read `useSocket().reconnectingConsultations?.[c.id]` in `Consultations.tsx:186` (`"está reconectando…"` vs `"está conectado/a"`).

#### 15. `web/src/__tests__/CallRoomWaitingGate.test.tsx`, `VetCallRoomClientRoleIsolation.test.tsx`, `SocketContext.test.tsx` (Modify)
- **Type / Scope:** Web Vitest Verification
- **Proposed Changes:** Replace `TRIAGE_CRITICAL_QUEUED` expectation with 4-state `WAITING`/`ACTIVE` + tutor-reconnecting banner coverage; test client manual exit isolation (`0` `/complete` and `0` `call:ended` calls), `huellicam:session_terminated` `<LiveKitRoom>` unmount, `409 DEVICE_SESSION_STALE` handling, `SocketContext` reconnection map, and `SESSION_MIGRATED_NEW_DEVICE` handling.

* **Phase 3 Checkpoint:** `npm run typecheck -w web && npm run build -w web && npm test -w web` (0 errors, 0 failures).

---

### Phase 4: Backfill SQL, Static Governance Guardrail & Canonical Docs

#### 16. `backend/prisma/scripts/backfill-consultation-4-states.sql` (Create)
- **Type / Scope:** Idempotent Pre-Deploy Migration Script
- **Proposed Changes:** Execute CTE updating any row in the 6 deprecated statuses (`vet_id IS NULL -> 'WAITING'`, `vet_id IS NOT NULL -> 'ACTIVE'`, recording `LEGACY_STATUS_BACKFILL` entries in `consultation_audit_log`), followed by `SELECT COUNT(*) AS remaining_deprecated FROM consultations WHERE status NOT IN ('WAITING', 'ACTIVE', 'COMPLETED', 'CANCELLED')`.

#### 17. `scripts/verify-governance.js` (Modify)
- **Type / Scope:** CI Governance Guardrail
- **Proposed Changes:** Add Check #5 recursively scanning `.ts`/`.tsx` files under `backend/src/` and `web/src/` (exempting only `backend/src/contracts/consultation.contract.ts`) and failing if any of the 6 deprecated `ConsultationStatus` literals remain.

#### 18. Documentation & Broken-Link Cleanup (Modify)
- **Scope:** `docs/audits/backend-audit.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/SPEC.md`, `docs/TECH_REFERENCE.md`, `docs/DECISIONS.md`, `backend/src/modules/consultations/README.md`, `backend/src/realtime/README.md`.
- **Proposed Changes:** Replace links to deleted `consultationConcurrency.service.ts` / `disconnectQueue.ts`, document the canonical 4-state contract, distributed `VetDisconnectTracker`, `consultation:tutor_reconnected`, and ADR-024 updates.

* **Phase 4 Checkpoint:** `npm run check:governance` (all 5 checks pass, 0 broken links).

--------------------------------------------------------------------------------

### Final Verification Plan

1. `npm run typecheck -w backend` (0 TypeScript errors)
2. `npm test -w backend -- --watchAll=false` (full Jest suite passes: CUJ 1 CAS handoff/same-device no-op/eviction/`409 DEVICE_SESSION_STALE`/`participant_joined`, CUJ 2 atomic Lua presence & `tutor_reconnecting`, CUJ 3 Redis ZSET `VetDisconnectTracker` + bounded post-call `Call.status === 'ENDED'` guard, CUJ 4 atomic 1-active-per-tutor guard + 6 audit log events)
3. `npm run typecheck -w web && npm run build -w web && npm test -w web` (0 errors, full Vitest suite passes including client exit isolation, `<LiveKitRoom>` eviction unmount, eager `GlobalCallListener` `?from=client` parity, and reconnection banner)
4. `npm run check:governance` (docs parity, zero broken links, zero deprecated enum literals outside `consultation.contract.ts`)
5. Dry-run verification of `backend/prisma/scripts/backfill-consultation-4-states.sql` syntax and idempotency.
