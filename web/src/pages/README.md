# Pages

## Overview
Top-level route pages of the Huellicam web application: public landing, unified authentication/recovery flows (`AuthExperience`), client tutor portal (`ClientApp`), administrative suite (`AdminApp`), public SENASA prescription verification (`PrescriptionView`), legal compliance pages, and 404 fallback.

## Interface
- `[ClientApp.tsx:ClientApp]` — Default-exported tutor portal dispatcher handling role redirects, lazy-loaded `VetApp`/`CallRoom`, `TriagePage`, `?state=` diagnostic modes, and `AppShell` subroutes (`/client/dashboard`, `/client/pets`, `/client/consultations`, `/client/appointments`, `/client/messages`, `/client/prescriptions`, `/client/notifications`, `/client/profile`, `/client/settings`).
- `[ClientApp.tsx:routes]`, `[ClientApp.tsx:mobileRoutes]`, `[ClientApp.tsx:isRouteActive]`, `[ClientApp.tsx:ClientViewPet]`, `[ClientApp.tsx:ClientViewConsultation]`, `[ClientApp.tsx:AppShell]`, `[ClientApp.tsx:NewPetModal]`, `[ClientApp.tsx:ConsultationsPage]`, `[ClientApp.tsx:AppointmentsPage]`, `[ClientApp.tsx:MessagesPage]`, `[ClientApp.tsx:TriagePage]`, `[ClientApp.tsx:TriageResult]` — Exported tutor portal views, layout shell, modals, and view-model types.
- `[AdminApp.tsx:AdminApp]` (default export `[AdminApp.tsx:default]`) — Multi-tab administrative suite (`/admin/dashboard`, `/admin/users`, `/admin/pets`, `/admin/consultations`, `/admin/vets`, `/admin/audit`) with user/pet CRUD, session revocation, chat inspection, SENASA vet review, pricing settings, and feature flags.
- `[PrescriptionView.tsx:PrescriptionView]` (default export `[PrescriptionView.tsx:default]`) — Public SENASA digital prescription viewer and print launcher (`PrescriptionDoc`).
- `[AuthExperience.tsx:AuthExperience]` — Default-exported unified authentication/registration/password-recovery experience (`/login`, `/register`, `/register/tutor`, `/register/veterinarian`, `/forgot-password`).
- `[Landing.tsx:Landing]` (default export `[Landing.tsx:default]`) — Public landing page with animated hero photo carousel and scroll-reveal sections (re-exports `Icon`, `Brand`, `Logo`, `Button`, `IconName` from `../components/common/Brand`).
- `[CookiePolicy.tsx:CookiePolicy]` (default export `[CookiePolicy.tsx:default]`) — Cookie policy page with consent reset action.
- `[TermsConditions.tsx:TermsConditions]` (default export `[TermsConditions.tsx:default]`) — Terms and conditions page inside `LegalLayout`.
- `[RefundPolicy.tsx:RefundPolicy]` (default export `[RefundPolicy.tsx:default]`) — Refund policy page inside `LegalLayout`.
- `[PrivacyPolicy.tsx:PrivacyPolicy]` (default export `[PrivacyPolicy.tsx:default]`) — Privacy policy page inside `LegalLayout`.
- `[NotFound.tsx:NotFound]` (default export `[NotFound.tsx:default]`) — 404 fallback page navigating back to `/`.

## Invariants
- `[ClientApp.tsx:ClientApp]` — Redirects `VET` users to `/vet/dashboard` and `ADMIN` users to `/admin/dashboard`; `useClientData` enables queries only when `!!user`.
- `[ClientApp.tsx:NewPetModal]`, `[ClientApp.tsx:PetDetail]` — Require non-empty pet name, block submission when weight assessment `isBlocking` is true, enforce 15-digit numeric microchips when provided, and require `customBreed` for `'Otra'`/`'Otro'` breeds.
- `[ClientApp.tsx:TriagePage]`, `[ClientApp.tsx:TriageResult]` — Block triage when `!petsLoading && pets.length === 0`; skip timeframe step for `'Control preventivo o consulta de rutina'`; submit backend `ClinicalSymptomKey` values and `SymptomDuration` enums without `[Prioridad: ...]` prefix so `clinicalTriage.engine.ts` runs deterministically.
- `[ClientApp.tsx:MessagesPage]`, `[ClientApp.tsx:PrescriptionsPage]`, `[ClientApp.tsx:SettingsPage]` — Upload real attachments to `/api/media`, map `attachmentUrl`, deduplicate socket messages by `id` and `clientMsgId`; classify prescriptions as `'Anteriores'` when `issued + (Number(rx.durationDays) || 7) * 86_400_000 < now`; await `logout()` cleanly before redirecting to `/login`.
- `[AdminApp.tsx:AdminApp]` — `handleSaveUser` strips `licenseNumber` unless `role === 'VET'` and omits blank password on `PATCH`; `handleSavePet` blocks on `adminPetWeightAssessment?.isBlocking`; `handleConfirmRejectVet` requires non-empty reason; `handleConfirmBan` invokes `/ban` once without redundant `/revoke-sessions`.
- `[PrescriptionView.tsx:PrescriptionView]` — Resolves prescription ID from `useParams().id || searchParams.get('code') || searchParams.get('id')`, forwards optional `sig` query param, and passes `consultation?.pet` to `<PrescriptionDoc />`.
- `[AuthExperience.tsx:AuthExperience]` — Enforce email regex, password length >= 8 (`passwordScore >= 2` and non-`hola@huellicam.com`) and 3-step vet credential validation; map `VET -> '/vet/dashboard'`, `ADMIN -> '/admin/dashboard'`, else `'/client/dashboard'`.
- `[Landing.tsx:Landing]` — Disables scroll/reveal observers and hero carousel auto-rotation/teleport transitions when `prefersReducedMotion()` is true.

## Side Effects
- `[ClientApp.tsx:ClientApp]` — Executes `GET/POST/PATCH` calls against `/api/pets`, `/api/consultations/mine`, `/api/consultations`, `/api/consultations/${id}/cancel`, `/api/consultations/${id}/messages`, `/api/media`, `/api/pets/${id}/documents`, `/api/notifications`, `/api/notifications/read-all`, `/api/prescriptions`, and `/api/users/profile`; reads/writes `localStorage`; joins/leaves Socket.IO rooms and subscribes to `message:new`; navigates via `go`/`window.location`.
- `[AdminApp.tsx:AdminApp]` — Calls `/api/admin/*` endpoints (`stats`, `executive-metrics`, `users`, `pets`, `consultations`, `audit-logs`, `pricing-settings`, `vets/pending`, `approve`, `reject`, `ban`, `restore`, `revoke-sessions`), mutates `window.history.pushState`, schedules toast/debounce timers, and injects `<ClientScopedStyle />` + `<ScopedStyle id="admin-style" />`.
- `[PrescriptionView.tsx:PrescriptionView]` — Calls `/api/prescriptions/${targetId}` and triggers `requestMobilePrintOrFallback`.
- `[AuthExperience.tsx:AuthExperience]`, `[Landing.tsx:Landing]`, `[CookiePolicy.tsx:CookiePolicy]` — Call `useAuth().login`/`register`/`logout` and `/api/auth/forgot-password|verify-reset-code|reset-password`; read/write/clear `localStorage` (`huellicam_cookie_consent`); manage `requestAnimationFrame`, `setInterval`, `IntersectionObserver`, and `window.location.reload()`.

## Verification
- Run: `npm test -w web`
