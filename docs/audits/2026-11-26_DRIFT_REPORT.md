# Huellicam — EGM Drift Report (`docs/` & `web/`)

> **Fecha:** 2026-11-26  
> **Alcance:** 8 documentos canónicos en `docs/` (excluyendo `docs/mobile/README.md` y `docs/audits/*`) + 21 contratos `README.md` generados en `web/`.  
> **Criterio:** Solo se reportan divergencias verificadas contra el código fuente actual (o `No drift detected.`).

---

## docs/ARCHITECTURE.md

- **Non-existent reference (`ensureDatabaseSchema`)**: Section 2 states `src/server.ts` runs startup schema verification via `ensureDatabaseSchema`, which does not exist in `backend/src/server.ts:1-117` or `backend/src/lib/prisma.ts:1-23`.
- **Incomplete Media Magic Bytes formats**: Section 2 states `src/modules/media/` inspects Magic Bytes for `JPEG/PNG/PDF`, omitting **WEBP** (`RIFF` + `WEBP`) validated in `verifyMagicBytes` (`backend/src/modules/media/media.middleware.ts:60-68`).
- **Realtime path & undocumented realtime modules**: Section 2 references `chat.gateway.ts` directly under `src/realtime/` instead of `backend/src/realtime/gateways/chat.gateway.ts`, and omits `backend/src/realtime/presence.service.ts` (`PresenceService`), `backend/src/realtime/disconnectQueue.ts` (`DisconnectQueue`), and `backend/src/realtime/socket.ratelimit.middleware.ts` (`applySocketRateLimiting`).
- **Undocumented backend infrastructure modules**: Section 2 omits `backend/src/middlewares/requestId.ts` (`requestIdMiddleware`), `backend/src/lib/logger.ts` (Pino logger with `AsyncLocalStorage` context and PII redaction), and `backend/src/lib/redis.ts` (`createRedisClient`, `initializeSharedRedisClient`, `closeAllRedisClients`).
- **Unrouted web components & inverted event-listener claim**: Section 3 lists `DashboardClient.tsx` and `ClinicalIntakeForm.tsx` under `ClientApp.tsx` for `/client/*`, and states `services/api.ts` listens for `SESSION_REVOKED` events. `web/src/App.tsx:18,219-220` mounts only `web/src/pages/ClientApp.tsx`, which never imports `web/src/pages/DashboardClient.tsx` or `web/src/components/dashboard/ClinicalIntakeForm.tsx`; `web/src/services/api.ts:126-141` detects `errorCode === 'SESSION_REVOKED'` and dispatches `huellicam:session_terminated`, while `web/src/context/AuthContext.tsx:163` is the listener.
- **Undocumented web telemetry, route, and call listener**: Section 3 omits Sentry initialization (`web/src/main.tsx:6-12`, `web/src/lib/sentry.ts:3-51`), the `/verify-rx` route (`web/src/App.tsx:235`), and `GlobalCallListener` (`web/src/components/call/GlobalCallListener.tsx`).
- **Feature flags not enforced at runtime**: Section 6 marks `PAYMENTS_ENABLED`, `TRIAGE_ACTIVE`, `VIDEOCALLS_ENABLED`, and `NEW_REGISTRATIONS_ENABLED` as operative; `featureFlagsService` (`backend/src/modules/admin/feature-flags.service.ts`) is only read/toggled in `backend/src/modules/admin/admin.controller.ts:222-239` and is never checked (`isEnabled` / `assertEnabled`) by `auth`, `consultations`, or `calls`.

## docs/SPEC.md

- **Contradicts code on `FOR UPDATE` row locking & unwired concurrency helpers**: Section 3.1 claims `consultationConcurrency.service.ts` supports claims with `FOR UPDATE` row locks and cross-device recovery. In `backend/src/modules/consultations/consultationConcurrency.service.ts:90,137,246,366`, all transactions run optimistic `stateVersion` CAS (`updateMany`) without pessimistic row locks. Additionally, `claimConsultationByVet` and `migrateTutorSession` are not invoked by `ConsultationsService.assignConsultation` (`backend/src/modules/consultations/consultations.service.ts:214-313`), `AuthController.login` (`backend/src/modules/auth/auth.controller.ts:59-101`), or `initializeSocketServer` (`backend/src/realtime/socket.server.ts:299-449`)—only `markSocketDisconnect` is wired via `DisconnectQueue`.
- **Unwired `checkVetDisconnectTimeout` grace window**: Section 3.1 specifies an automatic 3-minute vet-disconnect timeout (`checkVetDisconnectTimeout` with `[VET_DISCONNECTED_TIMEOUT]`). The method exists at `backend/src/modules/consultations/consultations.service.ts:170-213`, but has no caller or scheduler in `backend/src/`.
- **Architectural divergence on deterministic triage (`ADR-028`)**: Sections 1 and 3.2 state the tutor does not receive/choose urgency colors and `clinicalTriage.engine.ts` deterministically evaluates symptoms, breed, and duration on the backend (`ROJO`/`AMARILLO`/`VERDE`, `1..10`, `redFlags`). In reality, `web/src/pages/ClientApp.tsx:2916-2985,3244-3256` runs `evaluateClientTriage` on the client, displays the urgency tier before submission, and prepends `[Prioridad: ROJO|AMARILLO|VERDE]` via `formatConsultationNotes`, triggering the `legacyMatch` early return in `backend/src/modules/consultations/clinicalTriage.engine.ts:67-79`.
- **Contradicts code on Web access token storage**: Section 4.1 states that on Web the access token is kept in memory. In `web/src/services/api.ts:20-40`, `setAccessToken` persists the access token in `window.localStorage` (`huellicam_token`) and restores it on module load (`web/src/context/AuthContext.tsx:45,108,184,202` also caches `huellicam_user` in `localStorage`).
- **Incomplete Media Magic Bytes formats**: Section 4.2 lists only JPEG, PNG, and PDF Magic Bytes, omitting **WEBP** (`52494646` + `57454250`) allowed by `verifyMagicBytes` (`backend/src/modules/media/media.middleware.ts:61-68`).

## docs/TECH_REFERENCE.md

- **Password reset OTP TTL mismatch**: Section 2.1 (`POST /api/auth/forgot-password`) states the 6-digit OTP expires in `15 min`. In `backend/src/modules/auth/passwordReset.service.ts:47` and `backend/src/services/email.service.ts:106`, the OTP TTL is **10 minutes** (`Date.now() + 10 * 60 * 1000`).
- **Logic shortcut on `POST /api/pets/:id/documents` & missing Zod validation**: Section 2 claims all inputs are validated with Zod and Section 2.3 states `POST /api/pets/:id/documents` registers clinical document metadata. In `backend/src/modules/pets/pets.routes.ts:13` and `backend/src/modules/pets/pets.controller.ts:74-98`, `uploadDocument` performs no Zod validation, uses no `multer` middleware, persists nothing to PostgreSQL, and returns a synthetic object with a hardcoded `'1.2 MB'` fallback size.
- **Incomplete error envelope & media MIME types**: Section 2 omits the `requestId` field included in error payloads by `errorHandler` (`backend/src/middlewares/errorHandler.ts:30,38,52,69,99,114,136`), and Section 2.7 (`POST /api/media`) omits **WEBP** from the Magic Bytes formats validated in `backend/src/modules/media/media.middleware.ts:61-68`.
- **Missing LiveKit webhook events**: Section 2.6 (`POST /api/calls/webhook`) omits `room_aborted` and `track_publish_failed` handled in `CallsService.handleWebhook` (`backend/src/modules/calls/calls.service.ts:233-256`).
- **Contradicts code on mandatory `reason` in `PATCH /api/admin/vets/:id/reject`**: Section 2.9 states `reason` is mandatory. In `backend/src/modules/admin/admin.controller.ts:53`, `rejectVetSchema` is only parsed when `req.body && req.body.reason` is truthy; omitting `reason` passes `undefined` to `adminService.rejectVet` and succeeds.
- **Socket.io path, missing events, and false claim on `prescription:new`**:
  - Section 3 cites `chat.gateway.ts` directly under `backend/src/realtime/` instead of `backend/src/realtime/gateways/chat.gateway.ts`.
  - `ClientToServerEvents` omits `presence:heartbeat` (`backend/src/realtime/socket.types.ts:28`, `backend/src/realtime/socket.server.ts:423-448`).
  - `ServerToClientEvents` omits `call:answered`, `call:rejected`, `consultation:assigned`, `consultation:cancelled`, and `vet:presence` (`backend/src/realtime/socket.types.ts:34-35,44-59`).
  - Section 3 falsely claims `prescription:new` is not emitted today; `PrescriptionsService.createPrescription` (`backend/src/modules/prescriptions/prescriptions.service.ts:122-126`) actively emits `'prescription:new'` via `io.to(rooms).emit(...)`, and `web/src/context/SocketContext.tsx:376` listens for it.

## docs/DECISIONS.md

- **Incomplete Media Magic Bytes formats (`ADR-010`, `ADR-020`)**: Claims Magic Bytes validation only for `JPEG/PNG/PDF`, omitting **WEBP** validated in `verifyMagicBytes` (`backend/src/modules/media/media.middleware.ts:61-68`).
- **Row locking & unhooked concurrency/timeout logic (`ADR-024`)**: Claims row-level locking on claim, a 3-minute disconnect grace window, and transition auditing in `ConsultationAuditLog`. `backend/src/modules/consultations/consultationConcurrency.service.ts:90,137` uses optimistic `stateVersion` CAS without row locks; `ConsultationsService.assignConsultation` (`backend/src/modules/consultations/consultations.service.ts:214-313`) does not call `claimConsultationByVet` or insert `ConsultationAuditLog` rows; and `checkVetDisconnectTimeout` (`consultations.service.ts:170-213`) has no active caller/scheduler.
- **Triage intake & deterministic engine divergence (`ADR-028`)**: Claims tutors submit structured symptoms/duration via `ClinicalIntakeForm` without choosing urgency colors and `clinicalTriage.engine.ts` computes severity, score `1..10`, and `redFlags`. In reality, `web/src/App.tsx:219-220` routes `ClientApp.tsx` rather than `DashboardClient.tsx`/`ClinicalIntakeForm.tsx`; `web/src/pages/ClientApp.tsx:2916-2985,3244-3256` runs `evaluateClientTriage` on the client, shows the urgency tier before submission, and prepends `[Prioridad: ...]` via `formatConsultationNotes`, hitting `legacyMatch` in `backend/src/modules/consultations/clinicalTriage.engine.ts:67-79`.

## docs/DEPLOY.md

- **Backend deploy commands fail in workspace layout (`docs/DEPLOY.md:64-71`)**: Instructs running `cd backend` followed by `npm ci`, but `backend/package-lock.json` does not exist; the lockfile is at the monorepo root (`package-lock.json:1-5`), so `backend/Dockerfile:9-15` and `.github/workflows/ci.yml:28,89` run `npm ci` from the repository root instead.
- **Undocumented `web/vercel.json` (`docs/DEPLOY.md:79-83`)**: Documents only root `vercel.json` (`npm run build -w web`, `web/dist`, rewrite `/(.*) -> /web/dist/index.html`), omitting `web/vercel.json:1-11` (`buildCommand: "npm run build"`, `outputDirectory: "dist"`, `installCommand: "npm install"`, rewrite `/(.*) -> /index.html`).
- **Environment variable & template divergence (`docs/DEPLOY.md:30,45-46,85-90`)**:
  - `backend/src/config/env.ts:221-263` (`envSchema`) does not declare `COOKIE_SECURE`, `COOKIE_SAME_SITE`, or `COOKIE_DOMAIN`; `backend/src/modules/auth/auth.controller.ts:18-23` reads them directly from `process.env` (`COOKIE_DOMAIN` is undocumented in `docs/DEPLOY.md`).
  - `backend/.env.example:10-49` omits `DIRECT_URL` and `ENABLE_EMAIL_SCHEDULER`, while `.env.production.example:48-51` omits `VITE_SENTRY_DSN` (`web/src/main.tsx:6`).
  - `docs/DEPLOY.md:32-61` omits `UPLOAD_DIR`, `DB_POOL_LIMIT`, `DATABASE_CONNECTION_LIMIT`, `DB_POOL_TIMEOUT`, `DISCONNECT_DEBOUNCE_MS`, and does not note that missing or unreachable `REDIS_URL` aborts production startup (`backend/src/config/env.ts:264-272`, `backend/src/server.ts:24-30`, `backend/src/realtime/socket.server.ts:90-97`).
- **Incomplete CI / Docker operational coverage (`docs/DEPLOY.md:126-130`)**: Omits `npm run lint --if-present` (`.github/workflows/ci.yml:45-46`), the `security-scan` job running `npm audit --audit-level=critical` (`.github/workflows/ci.yml:157-170`), the root `verify:predeploy` script (`package.json:21`), and the container `HEALTHCHECK` against `http://localhost:3001/health` (`backend/Dockerfile:55-56`, `backend/src/app.ts:122-142`).

## docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md

- **Missing user anonymization on account deletion (`docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md:38`)**: Claims PostgreSQL performs soft-delete (`deletedAt`) and anonymization on user deletion. `backend/src/modules/users/users.routes.ts:10-12` exposes no account deletion route, and `AdminService.deleteUser` / `banUser` / `revokeUserSessionsAndSuspend` (`backend/src/modules/admin/admin.service.ts:361-415,744-760`) only set `deletedAt`, `isOnline: false`, and increment `tokenVersion` without anonymizing `email`, `firstName`, `lastName`, or `phone` (`AdminService.restoreUser` restores original PII intact).
- **Media formats and `GET /api/media/:id` access control divergence (`docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md:37`)**: Lists only `(JPEG, PNG, PDF)`, omitting `WEBP` (`backend/src/modules/media/media.middleware.ts:60-68`). Claims access control enforces consultation/pet relationship in `GET /api/media/:id`, whereas `MediaService.getMediaFile` (`backend/src/modules/media/media.service.ts:153-163`) checks only `ownerId`, `Role.ADMIN`, or `consultation.vetId` (checking neither `Pet` ownership nor `consultation.clientId`).
- **Sentry error reporting not gated on cookie consent (`docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md:39`)**: In `web/src/main.tsx:6-12` and `web/src/lib/sentry.ts:3-51`, `initSentry()` runs whenever `VITE_SENTRY_DSN` is set; declining `huellicam_cookie_consent` sets `tracesSampleRate`, `replaysSessionSampleRate`, and `replaysOnErrorSampleRate` to `0`, but `Sentry.init` still initializes and captures exceptions (`web/src/components/common/ErrorBoundary.tsx:24-28`), scrubbing only `user.email`, `user.username`, and `user.ip_address`.
- **Accessibility & palette claims vs. code (`docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md:54-55`)**:
  - Claims modal closing via `Escape`, which is missing in `NewPetModal` and inline `editModal`/`vaccineModal`/`documentModal` (`web/src/pages/ClientApp.tsx:627-804,1326-1527`), `AdminFeatureFlagsModal` (`web/src/components/admin/AdminFeatureFlagsModal.tsx:80-282`), `SessionTerminatedModal` (`web/src/components/common/SessionTerminatedModal.tsx:23-92`), `GlobalCallListener` (`web/src/components/call/GlobalCallListener.tsx:96-157`), and all 6 inline modals in `web/src/pages/AdminApp.tsx:1687-2234`.
  - Color tokens `#0F172A` and `#FFFAEF` do not match CSS theme tokens (`#183c3a` and `#fffbef` in `web/src/index.css:5-18`, `web/src/styles/client.css:1-20`, `web/src/styles/admin.css:6-24`, `web/src/styles/landing.css:12-25`).
- **Registration consent & audit schema omissions (`docs/MARCO_LEGAL_COMPLIANCE_Y_AUDITORIA.md:28,47`)**: `web/src/pages/AuthExperience.tsx:585-589` links only to `/terms` and `/privacy` (omitting `/refunds`), and `backend/prisma/schema.prisma:138-153` defines `ConsultationAuditLog` separately from `AuditLog`, which is undocumented in section 4.

## docs/payments/README.md

- **Volatile in-memory pricing & missing `Consultation.price` (`docs/payments/README.md:13-14`)**: `AdminService.currentPricingSettings` (`backend/src/modules/admin/admin.service.ts:812-872`) is stored in a static in-memory field (not persisted in PostgreSQL), resetting to `15000 / 0.2 / ARS` on restart or across replicas. `AdminService.getExecutiveMetrics` (`backend/src/modules/admin/admin.service.ts:892-903`) reads `(c as any).price` although `Consultation` in `backend/prisma/schema.prisma:104-136` has no `price` column, and counts only `WAITING` and `ACTIVE` in `waitingOrActive`, ignoring the other 6 `ConsultationStatus` values.
- **`PAYMENTS_ENABLED` and `FeatureFlagsService` are unpersisted and unenforced (`docs/payments/README.md:15`)**: `FeatureFlagsService` (`backend/src/modules/admin/feature-flags.service.ts:20-93`) holds flags solely in an in-memory `Map` initialized to `true`, and neither `isEnabled` nor `assertEnabled` is called anywhere outside `admin.controller.ts` and tests.

## docs/web/README.md

- **Outdated package versions (`docs/web/README.md:15,18`)**: Lists `Axios` as `1.7.x` (actual `web/package.json:20`: `"axios": "^1.12.0"`) and `Vitest` as `3.0.x` (actual `web/package.json:48`: `"vitest": "^4.1.12"`).
- **Mislocated component `ClinicalIntakeForm` (`docs/web/README.md:30`)**: Attributes `ClinicalIntakeForm` to `web/src/pages/ClientApp.tsx`, whereas `ClinicalIntakeForm` lives in `web/src/components/dashboard/ClinicalIntakeForm.tsx` (used by unrouted `DashboardClient.tsx`), and `ClientApp.tsx` implements `TriagePage` (`web/src/pages/ClientApp.tsx:2987`) and `TriageResult` (`web/src/pages/ClientApp.tsx:3212`).
- **Unprotected `/call/:id` route wrapper (`docs/web/README.md:24,32`)**: States main views are protected by role wrappers, yet `CallWrapper` in `web/src/App.tsx:88-91,227` performs no auth or role check and renders `<CallRoom id={id || 'milo'} />` directly.
- **`ScopedStyle` architectural divergence in `vet/` (`docs/web/README.md:48`)**: `web/src/vet/VetApp.tsx:3-4,365` and `web/src/vet/CallRoom.tsx:2-3,1751` use `ClientScopedStyle` plus a global `import "./vet.css";` rather than `ScopedStyle`, so `vet.css` stays mounted after leaving `VetApp` or `CallRoom`.
- **Undocumented web shell components & scripts (`docs/web/README.md:40-59`)**: Omits `VITE_SENTRY_DSN` initialization (`web/src/main.tsx:6-12`, `web/src/lib/sentry.ts`), `ErrorBoundary`, `OfflineBanner`, `CookieConsentBanner`, `MobileNavigationBridge`, and `AdminMobileRestriction` (`web/src/App.tsx:6-11,93-163,202-206`), plus `preview` and `build-storybook` scripts (`web/package.json:9,13`).

---

## web/README.md

- `web/README.md:13` claims `src/components/call/CallRoom.tsx:CallRoom` locks terminal states against stale async updates; `src/components/call/CallRoom.tsx:14-98` is only a `PreJoinModal` + `LiveKitRoom` wrapper with no terminal-state locking or async fetching (terminal-state locking lives in `src/pages/ConsultationRoom.tsx:161-268` and `src/vet/CallRoom.tsx:1082-1117,1316-1349`).
- `web/README.md:17` attributes React Query cache invalidation and `localStorage` draft/pet/chat caches to `src/services/api.ts:api` and `src/context/AuthContext.tsx:AuthProvider`; neither imports React Query or writes drafts/pet/chat caches (`SocketProvider` in `src/context/SocketContext.tsx:236-363` invalidates React Query caches, while `src/pages/*` and `src/vet/*` manage drafts and pet/chat caches). `AuthProvider` (`clearSession` at `src/context/AuthContext.tsx:56-66`) also clears `sessionStorage` on `401`/`403` and `huellicam:session_terminated`, not only on logout.
- `web/README.md:19` states `src/lib/mobileBridge.ts:postMobileBridgeMessage` exchanges navigation messages with `window.ReactNativeWebView`; `MobileBridgeOutgoingMessage` (`src/lib/mobileBridge.ts:11-19`) has no navigation message type (incoming native navigation is handled via the `window` `'huellicam:navigate'` listener in `src/App.tsx:93-113`).

## web/src/README.md

No drift detected.

## web/src/context/README.md

No drift detected.

## web/src/data/README.md

No drift detected.

## web/src/lib/README.md

- `web/src/lib/README.md:35` claims `consultationNotes.ts:formatConsultationNotes` always emits `VERDE` priority when `isRoutine` is true or `symptom` matches `/rutina|preventiv|control general/i`; in `src/lib/consultationNotes.ts:26-31`, `effectiveTier` only forces `'VERDE'` when `isRoutine` is `true` (`const effectiveTier = isRoutine ? 'VERDE' : (tier || 'VERDE')`), so when `isRoutine` is `false` and `symptom` matches that regex, the timeframe suffix is omitted while any passed non-default `tier` (`'ROJO'` or `'AMARILLO'`) is preserved.

## web/src/routes/README.md

No drift detected.

## web/src/services/README.md

No drift detected.

## web/src/styles/README.md

No drift detected.

## web/src/types/README.md

No drift detected.

## web/src/pages/README.md

- `web/src/pages/README.md:28` groups `ClientApp.tsx:PetDetail` with `ClientApp.tsx:NewPetModal` as enforcing 15-digit numeric microchips when provided; `NewPetModal` validates `cleanMicrochip.length !== 15` (`src/pages/ClientApp.tsx:608`), whereas `PetDetail`'s `handleSaveEdit` (`src/pages/ClientApp.tsx:1085-1106`) only strips non-digits and caps `maxLength={15}` on input (`src/pages/ClientApp.tsx:1437`) without enforcing 15 digits on submit.
- `web/src/pages/README.md:30` states `ClientApp.tsx:MessagesPage` deduplicates socket messages by `id` and `consultationId`; `handleNewMessage` (`src/pages/ClientApp.tsx:2017-2035`) filters by `msg.consultationId !== activeConsultationId` and deduplicates only by `newWAMsg.id` (`msg.id || msg.clientMsgId`).

## web/src/vet/README.md

No drift detected.

## web/src/components/README.md

No drift detected.

## web/src/components/admin/README.md

No drift detected.

## web/src/components/call/README.md

No drift detected.

## web/src/components/chat/README.md

No drift detected.

## web/src/components/common/README.md

No drift detected.

## web/src/components/dashboard/README.md

No drift detected.

## web/src/components/icons/README.md

No drift detected.

## web/src/components/legal/README.md

No drift detected.

## web/src/components/multimedia/README.md

No drift detected.

## web/src/components/ui/README.md

No drift detected.


---

# Addendum — README drift after the 4-state and web-audit remediation (2026-11-26, post-implementation)

> **Alcance:** READMEs de `backend/` y `web/` más `docs/ARCHITECTURE.md`, comparados contra el código actual tras `docs/designs/consultation-lifecycle-4-states.md` y `docs/audits/web-audit.md`. Este addendum documenta los desfasajes encontrados y cómo se resolvieron. No se modificó código fuente.
> **Nota:** varios hallazgos del reporte anterior (p. ej. `DisconnectQueue`, `ConsultationConcurrencyService`, `checkVetDisconnectTimeout` sin caller, `'milo'` en `CallWrapper`, `DashboardClient.tsx` sin ruta, `ClientApp` sin dedupe por `clientMsgId`) quedaron superados por esas remediaciones; el reporte anterior se conserva como registro histórico.

## backend/README.md

- Drift: cited `ConsultationConcurrencyService` (`src/modules/consultations/consultationConcurrency.service.ts`), a file deleted by the 4-state refactor. Resolved: removed the reference; the invariant now names only `ConsultationsService` and the 4 clinical states (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`).
- Drift: described `gracefulShutdown` as flushing `disconnectQueue`, a module that no longer exists (`src/realtime/disconnectQueue.ts` deleted). Resolved: now describes `vetDisconnectTracker.clear()` (Redis-backed deadlines, `src/realtime/vetDisconnectTracker.ts`) before and after closing `io` and `http.Server`, matching `src/server.ts`.

## web/README.md

- Drift: listed `ConsultationRoom` as a teleconsultation room in the overview. File deleted in web audit Phase 3 (orphan, no route). Resolved: overview now lists only `CallRoom`.
- Drift: invariant cited `src/components/call/CallRoom.tsx`, also deleted as orphan. Resolved: now cites only `src/vet/CallRoom.tsx`.

## docs/ARCHITECTURE.md

- Drift: tutor portal line cited `DashboardClient.tsx` as a support component; the file was deleted as orphan. Resolved: reference removed, `ClinicalIntakeForm.tsx` kept.

## backend/src/contracts

- Drift: directory with `consultation.contract.ts` (statuses, audit events, `extractDeviceId`, disconnect timing constants) had no README. Resolved: added `backend/src/contracts/README.md`.

## backend/prisma/scripts

- Drift: directory with `backfill-consultation-4-states.sql` had no README. Resolved: added `backend/prisma/scripts/README.md` (idempotent, single transaction, no enum alteration, verification query).

## backend/prisma/README.md, docs/TECH_REFERENCE.md

- No drift detected. Both still list the 6 deprecated `ConsultationStatus` literals, which is correct: the enum is intentionally kept in PostgreSQL until a future migration.

## web/src/stories

- Not changed. Contains only Storybook sample assets (PNG/SVG/AVIF), no project code to document.

## Scan notes

- The file-reference scan also flagged `express.json` in `backend/src/README.md` and `globalThis.prisma` in `backend/src/lib/README.md`. Both are code symbols, not files: false positives.
- `mobile/` was out of scope.
- Verification: `npm run check:governance` passed all 5 checks after the README edits. `backend/` typecheck and Jest (33 suites, 236 tests) and `web/` typecheck and Vitest (49 files, 177 tests) passed before the README edits; only `.md` files changed afterwards.
