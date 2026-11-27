# Call Components

## Overview
Provides Huellicam global Socket.IO incoming-call listener modal, pre-join audio/video device selection, and chat delivery status checkmarks.

## Interface
- `[GlobalCallListener.tsx:GlobalCallListener]` — Named and default React dialog component handling incoming clinical call notifications, critical call resumption, and accept/reject actions.
- `[PreJoinModal.tsx:PreJoinModal]` — Named and default React modal component allowing microphone and camera toggles prior to joining a consultation.
- `[WhatsAppCheck.tsx:WhatsAppCheck]` — Named React SVG status indicator component for `'sending' | 'sent' | 'delivered' | 'read' | 'failed'` message states.

## Invariants
- `[GlobalCallListener.tsx:GlobalCallListener]` Renders `null` when `incomingCall` is `null` and clears `incomingCall` plus audio ringtone when `socket` is absent or `huellicam:session_terminated` is dispatched.
- `[GlobalCallListener.tsx:handleDismissCall]` Clears `incomingCall` on `call:ended` or `consultation:cancelled` only if `payload?.consultationId` is omitted or matches `prev.consultationId`.
- `[PreJoinModal.tsx:PreJoinModal]` Initializes `audioEnabled` and `videoEnabled` to `true`, renders the cancel button only when `onCancel` is provided, and passes `(audioEnabled, videoEnabled)` to `onJoin`.
- `[WhatsAppCheck.tsx:WhatsAppCheck]` Defaults `state` to `"read"` and applies `#53bdeb` stroke only for `"read"`, using `#8696a0` for all other states.

## Side Effects
- `[GlobalCallListener.tsx:GlobalCallListener]` Subscribes to and cleans up `window` `'huellicam:session_terminated'` and Socket.IO `'call:incoming'`, `'consultation:critical_resume'`, `'call:ended'`, and `'consultation:cancelled'` listeners while stopping ringtone playback on teardown.
- `[GlobalCallListener.tsx:handleIncomingCall]` Starts incoming call audio playback via `startRingtone()`.
- `[GlobalCallListener.tsx:handleCriticalResume]` Calls `stopRingtone()` and navigates to `/call/${data.consultationId}` (preserving `?from=client` for `CLIENT`).
- `[GlobalCallListener.tsx:handleAccept]` Calls `stopRingtone()`, sends `PATCH /api/consultations/${cid}/assign` for non-`CLIENT` roles (swallowing failures), and navigates to `/call/${cid}` (with `?from=client` for `CLIENT`).
- `[GlobalCallListener.tsx:handleReject]` Calls `stopRingtone()` and emits Socket.IO `'call:rejected'` with `{ consultationId }` via `emitEvent`.

## Verification
- Run: `npm test -w web`
