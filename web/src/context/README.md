# Context

## Overview
React context providers for Huellicam authentication state, session restoration, and real-time Socket.IO communication with automatic React Query cache invalidation.

## Interface
- `[AuthContext.tsx:AuthContextType]` - Context contract exposing `user`, `loading`, `sessionTerminated`, `dismissSessionTerminated`, `clearSession`, `login`, `register`, `logout`, and `refreshSession`.
- `[AuthContext.tsx:AuthProvider]` - Root authentication provider managing cached user hydration, token lifecycle, and concurrent-login termination events.
- `[AuthContext.tsx:useAuth]` - Consumer hook returning `AuthContextType` (or a safe fallback whose `login`/`register` reject outside `AuthProvider`).
- `[SocketContext.tsx:ConsultationAssignedPayload]` - Event payload interface for `consultation:assigned`.
- `[SocketContext.tsx:ConsultationCancelledPayload]` - Event payload interface for `consultation:cancelled`.
- `[SocketContext.tsx:CallEndedPayload]` - Event payload interface for `call:ended`.
- `[SocketContext.tsx:NotificationNewPayload]` - Event payload interface for `notification:new`.
- `[SocketContext.tsx:PrescriptionNewPayload]` - Event payload interface for `prescription:new`.
- `[SocketContext.tsx:VetPresencePayload]` - Event payload interface for `vet:presence`.
- `[SocketContext.tsx:SessionTerminatedPayload]` - Event payload interface for `auth:session_terminated` and `session:invalidated`.
- `[SocketContext.tsx:SocketContextValue]` - Context contract exposing `socket`, `isConnected`, `joinConsultation`, `leaveConsultation`, and `emitEvent`.
- `[SocketContext.tsx:SocketProvider]` - Singleton Socket.IO lifecycle provider keyed by authenticated `userId` and auth readiness.
- `[SocketContext.tsx:useSocket]` - Consumer hook returning `SocketContextValue` (falls back to `NOOP_SOCKET_CONTEXT` outside `SocketProvider`).

## Invariants
- `[AuthContext.tsx:refreshSession]` - Probes `GET /api/auth/me` first instead of calling `/api/auth/refresh` unconditionally so the shared Axios interceptor handles single-flight 401 refresh and WebView-injected tokens without refresh cookies are preserved.
- `[AuthContext.tsx:refreshSession]` - Skips `/api/auth/me` on public auth routes (`/login`, `/register`, `/register/tutor`, `/register/veterinarian`, `/forgot-password`) when neither an access token nor cached `user` exists; clears the session only on HTTP `401`/`403` or status `>= 400` without user data.
- `[AuthContext.tsx:useAuth]` - Calling `login` or `register` outside `AuthProvider` throws `'useAuth must be used within an AuthProvider'`.
- `[SocketContext.tsx:SocketProvider]` - Maintains a single Socket.IO client per active `userId` (`canConnect` requires `userId` and either `!loading` or a resolved token) and clears `roomRefCountsRef` on logout or `userId` change.
- `[SocketContext.tsx:joinConsultation]` - Reference-counts rooms in `roomRefCountsRef` so `join:consultation` emits only on `0 -> 1` transitions (and reconnects) and `leave:consultation` emits only on `1 -> 0` transitions.
- `[SocketContext.tsx:emitEvent]` - Returns `false` safely when no active socket with `emit` exists.
- `[SocketContext.tsx:SocketProvider]` - Reads `QueryClientContext` directly so mounting without a `QueryClientProvider` remains safe.

## Side Effects
- `[AuthContext.tsx:AuthProvider]` - Reads `huellicam_user` from `window.localStorage` on initialization and attaches `window` (`huellicam:session_terminated`) and `document` (`visibilitychange`) listeners.
- `[AuthContext.tsx:clearSession]` - Removes `huellicam_user`, `huellicam_token`, and `huellicam_device_id` from `window.localStorage`, clears `window.sessionStorage`, sets access token to `null`, and invokes `notifyMobileAuthLogout`.
- `[AuthContext.tsx:login]` - Calls `POST /api/auth/login`, stores access token, persists `huellicam_user` in `window.localStorage`, and invokes `notifyMobileAuthSession`.
- `[AuthContext.tsx:register]` - Calls `POST /api/auth/register`, stores access token, persists `huellicam_user` in `window.localStorage`, and invokes `notifyMobileAuthSession`.
- `[AuthContext.tsx:logout]` - Calls `POST /api/auth/logout` and always runs `clearSession()` in `finally`.
- `[AuthContext.tsx:refreshSession]` - Calls `GET /api/auth/me`, updates `huellicam_user` in `window.localStorage`, and notifies the mobile bridge when an access token is available.
- `[SocketContext.tsx:SocketProvider]` - Opens a Socket.IO connection to `getWsUrl()`, listens to `window` `storage` updates for `huellicam_token`, triggers silent `refreshSession(true)` on token-related `connect_error`, dispatches `window` `CustomEvent('huellicam:session_terminated')` on session termination/invalidation events, emits room/custom socket events, and invalidates React Query caches (`consultations`, `consultation`, `notifications`, `prescriptions`).

## Verification
- Run: `npm test -w web`
