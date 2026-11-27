# Calls

## Overview
LiveKit video consultation signaling, token minting, room lifecycle management, and webhook telemetry ingestion module.

## Interface
- `[calls.routes.ts:default]` — Express `Router` exposing public `POST /webhook` (with `express.raw({ type: '*/*' })`) and `authenticate`-protected `POST /:consultationId/token` and `POST /:consultationId/ring`
- `[calls.controller.ts:CallsController]` — HTTP controller (`handleWebhook`, `getToken`, `ring`)
- `[calls.service.ts:CallsService]`, `[calls.service.ts:callsService]` — LiveKit and call lifecycle service (`deleteLiveKitRoom`, `removeParticipant`, `handleWebhook`, `generateLiveKitToken`, `ringCall`) and singleton instance
- `[calls.schemas.ts:ringCallSchema]` — Zod schema for optional call ring `notes`

## Invariants
- `[calls.routes.ts:router]`, `[calls.controller.ts:CallsController.handleWebhook]`, `[calls.service.ts:CallsService.handleWebhook]` — `POST /webhook` requires an `Authorization` header (HTTP `401` if absent) and verifies LiveKit HMAC signatures via `WebhookReceiver.receive` (`401` `INVALID_WEBHOOK_SIGNATURE` on failure).
- `[calls.service.ts:CallsService.generateLiveKitToken]`, `[calls.service.ts:CallsService.ringCall]` — Both operations require a non-deleted consultation in `ConsultationStatus.ACTIVE` and restrict access to `consultation.clientId`, `consultation.vetId`, or `Role.ADMIN`.
- `[calls.service.ts:CallsService.generateLiveKitToken]` — Mints a `15m` LiveKit `AccessToken` scoped to `room: consultationId` (`roomJoin`, `canPublish`, `canSubscribe`) using a zero-PII identity (`tutor_${user.id}:${consultation.activeDeviceId}` for clients with an active device, otherwise `user.id`).
- `[calls.service.ts:CallsService.ringCall]` — Requires a non-null `targetUserId` (`vetId` when caller is client, else `clientId`), throwing `400` `NO_TARGET_USER` otherwise.
- `[calls.service.ts:CallsService.handleWebhook]`, `[calls.service.ts:appendTelemetryEvent]` — Ignores `room_started`, `participant_joined`, `participant_left`, and duplicate `room_finished` updates once `call.status === CallStatus.ENDED`, and retains at most the latest 50 entries in `metadata.events`.

## Side Effects
- `[calls.service.ts:CallsService]` — Calls LiveKit `RoomServiceClient` (`deleteRoom`, `removeParticipant`) and mints JWTs via `AccessToken`.
- `[calls.service.ts:CallsService.ensureCallInitiated]`, `[calls.service.ts:CallsService.handleWebhook]` — Reads/writes PostgreSQL `call` and `consultation` records via Prisma (including `livekitRoomSid`, participant counts, duration, and error telemetry).
- `[calls.service.ts:CallsService.ringCall]` — Emits Socket.IO `call:incoming` to `user:${targetUserId}` (zero-PII payload) and dispatches `CALL_INCOMING` notifications via `notificationsService.createAndDispatch`.
- `[calls.service.ts:CallsService]`, `[calls.controller.ts:CallsController.handleWebhook]` — Writes structured logs via `logger`.

## Verification
- Run: `npm test -w backend`
