# Common Components

## Overview
Provides shared Huellicam UI primitives and application-wide guards for branding, authenticated password changes, cookie consent persistence, runtime error recovery, offline/online status banners, reference-counted scoped CSS injection, and forced session termination notices.

## Interface
- `[Brand.tsx:IconName]` — Union type of supported SVG icon names.
- `[Brand.tsx:Icon]` — Named React component rendering an `aria-hidden="true"` 24×24 SVG icon for a given `IconName`.
- `[Brand.tsx:Brand]` — Named React component rendering the Huellicam brand mark and wordmark.
- `[Brand.tsx:Logo]` — Named React component wrapping `Brand` in an anchor pointing to `/#inicio`.
- `[Brand.tsx:Button]` — Named React component rendering a styled `<button type="button">` or `<a>` with an optional trailing arrow icon.
- `[ChangePasswordModal.tsx:ChangePasswordModalProps]` — Props interface (`open`, `onClose`, optional `onSuccess`) for the password change modal.
- `[ChangePasswordModal.tsx:ChangePasswordModal]` — Named React modal component for authenticated password updates.
- `[CookieConsentBanner.tsx:CookieConsentBanner]` — Named and default React banner component capturing necessary and optional analytics cookie consent.
- `[DialogOverlay.tsx:useFocusTrap]` — Hook trapping keyboard Tab focus within a modal/drawer container, supporting `Escape` dismissal, body scroll lock, and trigger focus restoration.
- `[DialogOverlay.tsx:DialogOverlay]` — Accessible backdrop and dialog container wrapping `useFocusTrap`.
- `[ErrorBoundary.tsx:ErrorBoundary]` — Named and default React class error boundary component with reload recovery.
- `[OfflineBanner.tsx:OfflineBanner]` — Named and default React status/alert banner tracking browser connectivity changes.
- `[ScopedStyle.tsx:ScopedStyle]` — Named and default React component managing reference-counted `<style>` elements in `document.head`.
- `[SessionTerminatedModal.tsx:SessionTerminatedModal]` — Named and default React blocking dialog displayed when a session is displaced or an account is permanently banned.

## Invariants
- `[Brand.tsx:Button]` Renders `<button type="button">` when `onClick` is provided without `href`, and `<a href={href || "#"}>` otherwise; omits `<Icon name="arrow" />` when `variant === "ghost"`.
- `[ChangePasswordModal.tsx:ChangePasswordModal]` Returns `null` when `open` is `false` and resets input fields, password visibility flags, and `PasswordModalStatus` (`idle | submitting | error | success`) whenever `open` becomes `true`.
- `[ChangePasswordModal.tsx:handleSubmit]` Enforces non-empty `currentPassword`, `newPassword.length >= 8`, and `newPassword === confirmPassword` before dispatching the API request, disabling action buttons while `status.kind === "submitting"`.
- `[CookieConsentBanner.tsx:CookieConsentBanner]` Returns `null` when `showBanner` is `false` and remains hidden if `localStorage.getItem('huellicam_cookie_consent')` is present or throws.
- `[CookieConsentBanner.tsx:savePreferences]` Always persists `necessary: true` alongside `analytics: analyticsAllowed` and an ISO-8601 `timestamp`.
- `[ErrorBoundary.tsx:ErrorBoundary]` Transitions state via `getDerivedStateFromError` on child render errors and renders the fallback UI whenever `state.hasError` is `true`.
- `[OfflineBanner.tsx:OfflineBanner]` Initializes `isOffline` from `!navigator.onLine`, returns `null` when both `isOffline` and `reconnected` are `false`, and clears `timerRef` before updating state on connectivity transitions.
- `[ScopedStyle.tsx:ScopedStyle]` Reference-counts shared `<style id={id}>` mounts in `styleRefCounts` so the DOM element is removed only when `remaining <= 0`; always returns `null`.
- `[SessionTerminatedModal.tsx:SessionTerminatedModal]` Returns `null` when `sessionTerminated` is falsy and switches between ban and concurrent-session messaging based on `sessionTerminated.reason === 'ACCOUNT_BANNED'`.

## Side Effects
- `[ChangePasswordModal.tsx:ChangePasswordModal]` Schedules a 10 ms `window.setTimeout` to focus `currentInputRef` and registers/removes a `document` `Escape` `keydown` listener while `open` is `true`.
- `[ChangePasswordModal.tsx:handleSubmit]` Sends `PATCH /api/users/password` via `api.patch`, updates the access token via `setAccessToken` when returned, and invokes `onSuccess`.
- `[CookieConsentBanner.tsx:CookieConsentBanner]` Reads `'huellicam_cookie_consent'` from `localStorage` on mount.
- `[CookieConsentBanner.tsx:savePreferences]` Writes serialized `CookiePreferences` JSON to `localStorage` under `'huellicam_cookie_consent'` and logs a `console.warn` on storage failure.
- `[ErrorBoundary.tsx:componentDidCatch]` Logs uncaught errors with `console.error` and, when `import.meta.env.VITE_SENTRY_DSN` is truthy, dynamically imports `../../lib/sentry` and calls `Sentry.captureException`.
- `[ErrorBoundary.tsx:handleRetry]` Triggers a full page reload via `window.location.reload()`.
- `[OfflineBanner.tsx:OfflineBanner]` Registers and cleans up `window` `'offline'` and `'online'` event listeners plus a 3,500 ms `window.setTimeout` that hides the reconnected banner.
- `[ScopedStyle.tsx:ScopedStyle]` Mutates module-level `styleRefCounts` `Map` and inserts, updates, or removes `<style>` nodes in `document.head` inside `useLayoutEffect`.
- `[SessionTerminatedModal.tsx:handleAction]` Invokes `dismissSessionTerminated()` from `AuthContext` and navigates to `'/login'` via `react-router-dom` `navigate` (falling back to `window.location.href = '/login'`).

## Verification
- Run: `npm test -w web`
