# Huellicam Web Blueprint

## System Overview
React 18 + Vite + TypeScript single-page application powering the Huellicam veterinary telemedicine platform across public landing/legal pages, unified auth/OTP recovery, tutor portal (`ClientApp`), veterinary guard portal (`VetApp`), administrative console (`AdminApp`), WebRTC LiveKit teleconsultation rooms (`CallRoom`), and React Native WebView bridging.

## Subdirectories & System Boundaries
- Source: [./src/README.md](./src/README.md) - Application entrypoints (`App.tsx`, `main.tsx`, `shared.tsx`), reusable UI/feature components (`./src/components/README.md`), auth & Socket.IO contexts (`./src/context/README.md`), breed/weight catalogs (`./src/data/README.md`), browser/bridge utilities (`./src/lib/README.md`), route pages (`./src/pages/README.md`), access guard (`./src/routes/README.md`), Axios client (`./src/services/README.md`), scoped CSS (`./src/styles/README.md`), TypeScript contracts (`./src/types/README.md`), and veterinary clinical workspace (`./src/vet/README.md`).

## Global Invariants
- `[src/App.tsx:App]`, `[src/App.tsx:ClientWrapper]`, `[src/App.tsx:VetWrapper]`, `[src/App.tsx:AdminWrapper]`, `[src/routes/ProtectedRoute.tsx:ProtectedRoute]`: Portal routes enforce authenticated role separation (`CLIENT`, `VET`, `ADMIN`) after auth hydration completes, and `ADMIN` access inside `isReactNativeWebView()` is blocked via `AdminMobileRestriction`.
- `[src/services/api.ts:api]`, `[src/context/AuthContext.tsx:AuthProvider]`: HTTP requests inject `Authorization: Bearer <token>`, `x-device-id`, `X-Request-Id`, and `X-Correlation-Id`; concurrent `401` responses serialize behind a single-flight `POST /api/auth/refresh` queue while skipping retries on `/api/auth/login`, `/api/auth/refresh`, unauthenticated `/api/auth/me`, and `SESSION_REVOKED`.
- `[src/context/SocketContext.tsx:SocketProvider]`: Maintains one Socket.IO connection per authenticated `userId` with reference-counted `join:consultation`/`leave:consultation` rooms and triggers `huellicam:session_terminated` on `auth:session_terminated` or `session:invalidated`.
- `[src/lib/livekitConfig.ts:LIVEKIT_ROOM_OPTIONS]`, `[src/vet/CallRoom.tsx:CallRoom]`: Teleconsultation rooms lock terminal states against stale async updates and apply shared LiveKit VP8 simulcast/adaptive stream presets.
- `[src/lib/sentry.ts:initSentry]`, `[src/components/common/CookieConsentBanner.tsx:CookieConsentBanner]`: Sentry tracing and session replay are gated behind explicit `huellicam_cookie_consent.analytics === true` and scrub user PII in `beforeSend`.

## Global Side Effects
- `[src/services/api.ts:api]`, `[src/context/AuthContext.tsx:AuthProvider]`: Issues REST calls to `getApiUrl()`, reads/writes `localStorage` (`huellicam_user`, `huellicam_token`, `huellicam_device_id`, drafts, and pet/chat caches), clears `sessionStorage` on logout, and invalidates React Query caches.
- `[src/context/SocketContext.tsx:SocketProvider]`, `[src/components/call/GlobalCallListener.tsx:GlobalCallListener]`: Maintains persistent Socket.IO connections to `getWsUrl()`, plays Web Audio ringtones (`ringtone.ts`), and dispatches `window` custom events (`huellicam:session_terminated`).
- `[src/lib/mobileBridge.ts:postMobileBridgeMessage]`: Exchanges session, navigation, wake-lock, print, and call lifecycle messages with `window.ReactNativeWebView`.
- `[src/components/common/ScopedStyle.tsx:ScopedStyle]`, `[src/lib/sentry.ts:initSentry]`: Injects reference-counted `<style>` nodes into `document.head` and initializes `@sentry/react` when `VITE_SENTRY_DSN` is configured.

## System Verification
- Run: `npm test -w web`
