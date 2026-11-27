# Lib

## Overview
Shared Huellicam frontend utilities for consultation note formatting/sanitization, LiveKit server URL resolution, React Native WebView bridge messaging, reduced-motion helpers, pet weight validation re-exports, Web Audio ringtone synthesis, Sentry telemetry, CSS class merging, and WebSocket URL resolution.

## Interface
- `[authenticatedMedia.ts:isProtectedMediaUrl]`, `[authenticatedMedia.ts:normalizeMediaUrl]`, `[authenticatedMedia.ts:buildAbsoluteMediaUrl]`, `[authenticatedMedia.ts:fetchAuthenticatedMediaBlobUrl]`, `[authenticatedMedia.ts:downloadAuthenticatedMedia]`, `[authenticatedMedia.ts:useAuthenticatedMediaUrl]`, `[authenticatedMedia.ts:AuthenticatedMediaImage]` - Authenticated Bearer blob fetching, download, and cleanup helpers for `/api/media/:id`.
- `[registerDraft.ts:REGISTER_DRAFT_KEY]`, `[registerDraft.ts:RegisterDraft]`, `[registerDraft.ts:getRegisterDraft]`, `[registerDraft.ts:saveRegisterDraft]`, `[registerDraft.ts:clearRegisterDraft]` - Password-free registration draft storage helpers.
- `[consultationNotes.ts:ParsedConsultationNotes]` - Parsed note structure `{ cleanNotes, cancellationReason, priority }`.
- `[consultationNotes.ts:FormatConsultationNotesParams]` - Parameters `{ tier?, symptom, timeframe?, isRoutine? }` for note formatting.
- `[consultationNotes.ts:formatConsultationNotes]` - Serializes symptom, priority tag, and optional timeframe into backend note format.
- `[consultationNotes.ts:parseConsultationNotes]` - Strips internal `[Prioridad: ...]`, `[Triage IA: ...]`, and `[CANCELLED_...]` tags into user-facing text.
- `[formatters.ts:getInitials]`, `[formatters.ts:formatBadgeCount]`, `[formatters.ts:formatDateAR]`, `[formatters.ts:formatTimeAR]`, `[formatters.ts:formatCurrencyAR]`, `[formatters.ts:formatPluralAR]` - Grapheme-safe initials, `99+` badge caps, and `Intl`-guarded `es-AR` date/time/currency/plural formatters.
- `[livekitConfig.ts:LIVEKIT_ROOM_OPTIONS]` - LiveKit `RoomOptions` preset (`adaptiveStream`, `dynacast`, `h720`, VP8 simulcast layers `h180`/`h360`, `maintain-framerate`).
- `[mobileBridge.ts:MobileBridgeSessionUser]` - Minimal user shape transmitted over the native mobile bridge.
- `[mobileBridge.ts:MobileBridgeOutgoingMessage]` - Discriminated union of WebView bridge messages (`page:ready`, `auth:session`, `auth:logout`, `wakelock:acquire`, `wakelock:release`, `call:ended`, `print:request`, `external:open`).
- `[mobileBridge.ts:isReactNativeWebView]` - Detects `window.ReactNativeWebView?.postMessage`.
- `[mobileBridge.ts:postMobileBridgeMessage]` - Posts JSON-serialized messages to `window.ReactNativeWebView`.
- `[mobileBridge.ts:notifyMobileAuthSession]` - Emits `'auth:session'` bridge message with token and user summary.
- `[mobileBridge.ts:notifyMobileAuthLogout]` - Emits `'auth:logout'` bridge message.
- `[mobileBridge.ts:buildPrintableHtmlSnapshot]` - Serializes a DOM element and active page stylesheets into a standalone printable HTML document.
- `[mobileBridge.ts:requestMobilePrintOrFallback]` - Sends `'print:request'` in WebView or invokes `window.print()` in standard browsers.
- `[mobileBridge.ts:requestMobileExternalOpen]` - Sends `'external:open'` when inside React Native WebView.
- `[motion.ts:prefersReducedMotion]` - Safely evaluates `(prefers-reduced-motion: reduce)` media query.
- `[motion.ts:clamp]` - Clamps a number to `[min, max]`.
- `[petWeightValidation.ts:getWeightAssessment]` - Re-export from `../data/petBreeds`.
- `[petWeightValidation.ts:BREED_WEIGHT_STANDARDS]` - Re-export from `../data/petBreeds`.
- `[petWeightValidation.ts:SPECIES_WEIGHT_LIMITS]` - Re-export from `../data/petBreeds`.
- `[ringtone.ts:ringtone]` - Singleton `RingtoneSynthesizer` instance.
- `[ringtone.ts:startRingtone]` - Starts the repeating Web Audio ringtone cadence.
- `[ringtone.ts:stopRingtone]` - Stops the ringtone timer and disconnects active audio nodes.
- `[sentry.ts:initSentry]` - Initializes `@sentry/react` browser tracing and session replay.
- `[sentry.ts:Sentry]` - Re-export of `@sentry/react`.
- `[useVisualViewport.ts:useVisualViewport]` - Tracks `window.visualViewport` height and software keyboard inset (`viewportHeight`, `keyboardInset`, `isKeyboardOpen`) with safe fallback when unavailable.
- `[useIsMobileViewport.ts:useIsMobileViewport]` - Tracks `matchMedia('(max-width: 820px)')`, defaulting safely to `false` in SSR/jsdom environments.
- `[utils.ts:cn]` - Filters falsy class values and joins with spaces.
- `[ws.ts:getWsUrl]` - Resolves Socket.IO server URL from `VITE_WS_URL`, `window.location.origin`, or `http://localhost:3001`.

## Invariants
- `[consultationNotes.ts:formatConsultationNotes]` - Routine consultations (`isRoutine` or symptom matching `/rutina|preventiv|control general/i`) always emit `VERDE` priority and omit timeframe suffixes.
- `[consultationNotes.ts:parseConsultationNotes]` - Defaults blank or stripped notes to `'Consulta médica general'` and removes accidental timeframe parentheticals from routine notes.
- `[mobileBridge.ts:notifyMobileAuthSession]` - No-ops when `token` or `user?.id` is falsy.
- `[mobileBridge.ts:buildPrintableHtmlSnapshot]` - Returns `undefined` if `element` is null or `document` is undefined; HTML-escapes base href/title attributes and injects `.no-print, .print\:hidden` hiding rules.
- `[ringtone.ts:ringtone]` - Prevents overlapping playback via `isPlaying` guard and synthesizes 440 Hz + 554.37 Hz sine tones (1.2s duration every 3000ms) with zero external audio files.
- `[sentry.ts:initSentry]` - Skips initialization when `VITE_SENTRY_DSN` is missing; disables performance tracing and replay sampling unless `huellicam_cookie_consent` in `localStorage` has `analytics: true`; strips `event.user.email`, `username`, and `ip_address` in `beforeSend`.
- `[ws.ts:getWsUrl]` - Falls back to `window.location.origin` on non-localhost hostnames when `VITE_WS_URL` is absent or targets localhost so proxy forwarding works.

## Side Effects
- `[mobileBridge.ts:postMobileBridgeMessage]` - Calls `window.ReactNativeWebView.postMessage`.
- `[mobileBridge.ts:buildPrintableHtmlSnapshot]` - Reads `document.querySelectorAll('style, link[rel="stylesheet"]')`, `element.outerHTML`, and `window.location.origin`.
- `[mobileBridge.ts:requestMobilePrintOrFallback]` - Triggers native `'print:request'` message or browser `window.print()`.
- `[ringtone.ts:ringtone]` - Creates/resumes `AudioContext`, schedules `OscillatorNode` and `GainNode` playback to `ctx.destination`, and manages a `window.setInterval` timer.
- `[sentry.ts:initSentry]` - Reads `huellicam_cookie_consent` from `localStorage` and initializes global Sentry SDK instrumentation.

## Verification
- Run: `npm test -w web`
