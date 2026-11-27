# Web Source (`src`)

## Overview
Entrypoints, global providers, routing shell, and shared primitives for the Huellicam React + Vite frontend (`main.tsx`, `App.tsx`, `shared.tsx`, `vite-env.d.ts`), coordinating authentication, Socket.IO realtime rooms, React Query caching, React Native WebView bridging, and role-scoped portals.

## Interface
- `[App.tsx:ScopedStyle]`: Re-exported `ScopedStyle` component from `./components/common/ScopedStyle`.
- `[App.tsx:App]`: Named and default export (`React.FC`) rendering `ErrorBoundary > QueryClientProvider > AuthProvider > SocketProvider > BrowserRouter` with routes `/`, `/login`, `/register/*`, `/register`, `/forgot-password`, `/client/*`, `/client`, `/vet/*`, `/vet`, `/call/:id`, `/admin/*`, `/admin`, `/prescriptions/:id`, `/verify-rx`, `/privacy`, `/terms`, `/cookies`, `/refunds`, and `*`.
- `[main.tsx:entrypoint]`: Application bootstrap mounting `<App />` into `#root` and scheduling conditional Sentry initialization.
- `[shared.tsx:IconName]`, `[shared.tsx:Icon]`, `[shared.tsx:photos]`, `[shared.tsx:go]`, `[shared.tsx:Button]`, `[shared.tsx:Status]`, `[shared.tsx:Logo]`, `[shared.tsx:PageHeader]`, `[shared.tsx:Tabs]`, `[shared.tsx:MessageState]`, `[shared.tsx:MessageBubble]`, `[shared.tsx:NoticeTone]`, `[shared.tsx:Alert]`, `[shared.tsx:Toast]`, `[shared.tsx:Field]`, `[shared.tsx:EmptyState]`, `[shared.tsx:Modal]`: Shared UI primitives, icon registry, sample pet image catalog, and history-navigation helpers.
- `[vite-env.d.ts:ImgHTMLAttributes]`, `[vite-env.d.ts:ImportMetaEnv]`, `[vite-env.d.ts:ImportMeta]`: TypeScript declarations for `fetchpriority` and `VITE_API_URL` / `VITE_WS_URL` / `VITE_LIVEKIT_URL`.
- Components: [./components/README.md](./components/README.md) - Reusable UI, admin, call, chat, common, dashboard, icon, legal, and multimedia components.
- Context: [./context/README.md](./context/README.md) - `AuthProvider` and `SocketProvider`.
- Data: [./data/README.md](./data/README.md) - Species/breed catalog, weight standards, and image compression.
- Lib: [./lib/README.md](./lib/README.md) - Clinical note parser, LiveKit config, mobile WebView bridge, ringtone, Sentry, and WS URL helpers.
- Pages: [./pages/README.md](./pages/README.md) - Route-level pages (`ClientApp`, `AdminApp`, `AuthExperience`, `Landing`, `PrescriptionView`, legal pages).
- Routes: [./routes/README.md](./routes/README.md) - `ProtectedRoute` guard.
- Services: [./services/README.md](./services/README.md) - Configured Axios `api` client with single-flight 401 refresh.
- Styles: [./styles/README.md](./styles/README.md) - Scoped CSS wrappers (`ClientScopedStyle`, `LandingScopedStyle`).
- Types: [./types/README.md](./types/README.md) - Shared TypeScript domain and component contracts.
- Vet: [./vet/README.md](./vet/README.md) - Veterinary console (`VetApp`, `VetProvider`, `CallRoom`, clinical records, prescriptions, agenda).

## Invariants
- `[App.tsx:queryClient]`: Configures React Query defaults with `staleTime: 300000` (5 minutes) and `retry: 1`.
- `[App.tsx:ClientWrapper]`, `[App.tsx:VetWrapper]`, `[App.tsx:AdminWrapper]`: Wait for `!loading` before redirecting mismatched or unauthenticated users (`replace: true`); `AdminWrapper` renders `AdminMobileRestriction` instead of `AdminApp` when `isReactNativeWebView()` is true.
- `[App.tsx:CallWrapper]`: Renders `NotFound` when the `:id` route parameter is missing or blank.
- `[App.tsx:MobileNavigationBridge]`: Ignores `'huellicam:navigate'` events unless `detail?.path?.trim()` is non-empty and starts with `'/'`.
- `[App.tsx:AuthenticatedCallListener]`, `[App.tsx:App]`: Mounts `GlobalCallListener` only when `useAuth().user` is truthy, and suppresses `CookieConsentBanner` inside `isReactNativeWebView()`.
- `[main.tsx:VITE_SENTRY_DSN]`, `[main.tsx:rootElement]`: Initializes Sentry only when `import.meta.env.VITE_SENTRY_DSN` is set, and mounts React only when `#root` exists.
- `[shared.tsx:Logo]`, `[shared.tsx:MessageBubble]`, `[shared.tsx:Modal]`: `Logo` defaults target route from `localStorage.getItem('huellicam_user')` role unless `to` is passed; `MessageBubble` defaults `state` to `'read'` when `mine` is true; `Modal` traps Tab/Shift+Tab focus and closes on Escape or scrim click.

## Side Effects
- `[App.tsx:ClientWrapper]`, `[App.tsx:VetWrapper]`, `[App.tsx:AdminWrapper]`: Call `navigate(..., { replace: true })` inside `useEffect` on role/auth mismatch.
- `[App.tsx:MobileNavigationBridge]`: Subscribes to `window` `'huellicam:navigate'`, invokes `navigate(targetPath)`, and dispatches `PopStateEvent('popstate')`.
- `[App.tsx:AdminMobileRestriction]`: Calls `logout()` then `navigate('/login', { replace: true })`, or invokes `requestMobileExternalOpen(window.location.href)`.
- `[main.tsx:import]`, `[main.tsx:VITE_SENTRY_DSN]`, `[main.tsx:ReactDOM.createRoot]`: Imports `./index.css`, schedules deferred `import('./lib/sentry')` -> `initSentry()` via `requestIdleCallback` or `1500` ms `setTimeout`, and mounts `<App />` into `#root`.
- `[shared.tsx:go]`, `[shared.tsx:Logo]`, `[shared.tsx:EmptyState]`, `[shared.tsx:Modal]`: Mutate `window.history.pushState`, dispatch `PopStateEvent('popstate')`, scroll to top, reload on `'Reintentar'`, read `localStorage` (`huellicam_user`), and manage `document` `keydown` listeners plus focus restoration.

## Verification
- Run: `npm test -w web`
