# Huellicam Veterinary Clinical Workspace (`vet`)

## Overview
The `vet` package implements the Huellicam veterinary professional console, shared clinical state/UI primitives, backend-to-UI mappers, patient clinical record views, prescription issuance workflow, and the dual-role WebRTC teleconsultation room (`CallRoom`). It coordinates real-time consultation queues, Socket.IO rooms/events, LiveKit media sessions, and local session/draft state on top of `../shared`, `../services/api`, `../context/AuthContext`, and `../context/SocketContext`.

## Interface
- `[VetApp.tsx:VetApp]` — Default-exported veterinary portal shell handling `/vet/*` routing, `CLIENT` role redirection, and `?state=` diagnostic overrides (`empty`, `loading`, `error`).
- `[VetApp.tsx:QueueRow]` — Priority triage row card with live wait timer, availability guard, and patient review drawer.
- `[CallRoom.tsx:CallRoom]` — Default-exported teleconsultation room wrapping `Room` inside `VetProvider` keyed by consultation `id`.
- `[CallRoom.tsx:LiveKitTrackSynchronizer]` — Headless component syncing `mic` and `cam` state to LiveKit `localParticipant`.
- `[CallRoom.tsx:CallRoomPanel]` — Type union `"" | "Chat" | "Ficha" | "Evolución"` for side drawers inside `CallRoom`.
- `[CallRoom.tsx:getWsUrl]` — Re-export of the WebSocket URL resolver from `../lib/ws`.
- `[CallRoom.tsx:WhatsAppCheck]` — Re-export of `WhatsAppCheck` from `../components/call/WhatsAppCheck`.
- `[vetkit.tsx:VetProvider]` — Context provider synchronizing VET consultations, prescriptions, local draft persistence, availability status, and Socket.IO `consultation:new` alerts.
- `[vetkit.tsx:useVet]` — Hook returning the active `VetProvider` context value.
- `[vetkit.tsx:Avail]` — Availability union type `"Disponible" | "No disponible" | "En consulta"`.
- `[vetkit.tsx:LightboxItem]` — Media lightbox item shape `{ src: string; caption: string; pos?: string }`.
- `[vetkit.tsx:TriageBadge]` — Triage severity indicator with level pips and screen-reader label.
- `[vetkit.tsx:WaitTimer]` — Self-incrementing `MM:SS` wait timer.
- `[vetkit.tsx:PetPhoto]` — Lazy-loaded patient photo avatar.
- `[vetkit.tsx:ConsultStatus]` — Tone-mapped consultation/prescription/follow-up status pill.
- `[vetkit.tsx:Lightbox]` — Accessible image zoom modal with keyboard navigation.
- `[vetkit.tsx:Sheet]` — Accessible focus-trapped slide-over drawer.
- `[vetkit.tsx:ChatPanel]` — Clinical chat panel supporting Socket.IO rooms, HTTP message fallback, `/api/media` uploads, quick replies, and local demo threads.
- `[vetkit.tsx:FilterSelect]` — Labeled dropdown filter control.
- `[Consultations.tsx:ConsultationsPage]` — Tabbed and filterable consultations directory.
- `[Consultations.tsx:ConsultationDetail]` — Multi-pane consultation workspace (Video, Ficha, Chat, Evolución) and completion modal.
- `[Consultations.tsx:FichaClinica]` — Structured clinical record view (allergies, medications, demographics, history, vaccines, studies, documents, evolution).
- `[Consultations.tsx:EvolutionEditor]` — Clinical evolution note editor and timeline list.
- `[Patients.tsx:PatientsPage]` — Searchable and filterable patient table/card directory.
- `[Patients.tsx:PatientDetail]` — Patient header card and full `FichaClinica` view.
- `[Agenda.tsx:AppointmentsPage]` — Daily, weekly, and upcoming appointment views with reschedule and cancellation modals.
- `[Agenda.tsx:AvailabilityPage]` — Weekly schedule editor and current availability switcher.
- `[Messages.tsx:MessagesPage]` — Conversation list and active `ChatPanel` inbox.
- `[Prescriptions.tsx:PrescriptionsPage]` — Tabbed list of issued, draft, and finalized prescriptions.
- `[Prescriptions.tsx:NewPrescription]` — Prescription form supporting local drafts and official QR issuance.
- `[Prescriptions.tsx:PrescriptionDetail]` — Prescription card with QR verification display, clipboard copy, and public verification link launcher.
- `[Admin.tsx:FollowUpsPage]` — Priority-ordered follow-up list and detail sheet.
- `[Admin.tsx:ProfilePage]` — Professional profile editor and avatar uploader.
- `[Admin.tsx:SettingsPage]` — Notification switches, timezone info, and change-password modal trigger.
- `[mappers.ts:BackendConsultation]` — Re-exported `Consultation` type from `../types`.
- `[mappers.ts:mapBackendTriage]` — Maps `'ROJO' | 'AMARILLO' | 'VERDE' | null` to `Triage`.
- `[mappers.ts:mapBackendPetToPatient]` — Maps backend pet and client objects into a `Patient` record.
- `[mappers.ts:mapConsultationToQueueItem]` — Maps backend consultation into a `QueueItem`.
- `[mappers.ts:mapConsultationToConsult]` — Maps backend consultation into a `Consult`.
- `[data.ts:Triage]`, `[data.ts:Vaccine]`, `[data.ts:Evolution]`, `[data.ts:Patient]`, `[data.ts:QueueItem]`, `[data.ts:ConsultStatus]`, `[data.ts:Consult]`, `[data.ts:EventStatus]`, `[data.ts:AgendaEvent]`, `[data.ts:Msg]`, `[data.ts:Thread]`, `[data.ts:Rx]`, `[data.ts:FollowUp]` — Core domain TypeScript types for the veterinary console.
- `[data.ts:registerPatient]`, `[data.ts:registerPatients]`, `[data.ts:getAllPatients]`, `[data.ts:getPatient]` — In-memory patient registry mutators and fallback-safe lookup.
- `[data.ts:getDynamicWeekDays]` — Generates the Monday-to-Sunday descriptor array for the current week.
- `[data.ts:triageMeta]`, `[data.ts:patients]`, `[data.ts:initialQueue]`, `[data.ts:initialConsults]`, `[data.ts:weekDays]`, `[data.ts:todayIndex]`, `[data.ts:initialEvents]`, `[data.ts:availability]`, `[data.ts:initialThreads]`, `[data.ts:quickReplies]`, `[data.ts:initialRx]`, `[data.ts:initialFollowUps]` — Static metadata, calendar constants, and seed datasets.

## Invariants
- `[vetkit.tsx:useVet]` throws `"useVet fuera de VetProvider"` if called outside `[vetkit.tsx:VetProvider]`.
- `[vetkit.tsx:VetProvider]` executes presence sync, React Query fetches (`['consultations', 'vet']`, `['prescriptions', 'vet', user?.id]`), and `consultation:new` socket subscriptions only when `!forceEmpty && user?.role === "VET"`.
- `[vetkit.tsx:VetProvider]` intercepts transitions to `"No disponible"` with a confirmation modal when `queue.length > 0`, and stores only `"Borrador"` prescriptions in `localStorage` (`huellicam_vet_rx`) while prepending backend `"Emitida"` prescriptions ahead of drafts.
- `[VetApp.tsx:VetApp]` redirects authenticated `CLIENT` users to `/client/dashboard`; `[VetApp.tsx:QueueRow]` disables request review while `avail === "No disponible"`; `[VetApp.tsx:sortedQueue]` orders queue entries by `triageMeta[triage].rank` ascending and then `wait` descending.
- `[CallRoom.tsx:CallRoom]` passes `forceEmpty={user?.role !== "VET"}` to `VetProvider` and keys `[CallRoom.tsx:Room]` by `id` to reset per-call state across consultation switches.
- `[CallRoom.tsx:Room]` initializes `panel` to `""` so live video is unobstructed on entry, hides the `Evolución` tab when `fromClient` is true, guards defensive VET auto-assignment with `assignAttemptedRef`, latches terminal call state with `callEndedRef`, and waits 15 seconds on unexpected `LiveKitRoom` disconnects before invoking `handleFinalize`.
- `[vetkit.tsx:ChatPanel]` and `[CallRoom.tsx:CallChatPanel]` ignore stale async socket/HTTP/upload callbacks across unmount or consultation changes using `isStaleTarget`, and deduplicate messages by `id` or `clientMsgId`.
- `[data.ts:getPatient]` checks `[data.ts:dynamicPatients]` before the static `[data.ts:patients]` seed array and always returns a valid fallback `Patient`; `[data.ts:getAllPatients]` returns only entries stored in `dynamicPatients`.
- `[mappers.ts:mapBackendTriage]` maps `'ROJO'` to `'Crítico'`, `'AMARILLO'` to `'Moderado'`, and `'VERDE' | null` to `'General'`; `[mappers.ts:mapConsultationToQueueItem]` clamps wait seconds to `>= 0`.
- `[Consultations.tsx:ConsultationsPage]` resolves its initial tab from URL `?tab=`, then `sessionStorage`, then `"Próximas"`; `[Consultations.tsx:EvolutionEditor]` rejects blank notes; `[Consultations.tsx:ConsultationDetail]` renders the finish action only when `status === "Activa"`.
- `[Patients.tsx:PatientsPage]` forces an empty patient list whenever `forceEmpty` is true.
- `[Agenda.tsx:AvailabilityPage]` validates that enabled days have non-empty `start` and `end` with `start < end`; `[Agenda.tsx:EventCard]` and `[Agenda.tsx:AppointmentsPage]` omit reschedule/cancel actions on `"Completada"`/`"Cancelada"` events and disable past weekdays (`i < todayIndex`).
- `[Prescriptions.tsx:NewPrescription]` requires `["pet", "med", "dose", "freq", "duration"]` and a non-cancelled `consultationId` to issue an official QR prescription (defaulting numeric duration parsing to `7` days), and `["pet", "med"]` for drafts; `[Prescriptions.tsx:PrescriptionDetail]` skips network fetch when a local match is `"Borrador"` or already holds `qrCodeDataUrl`.
- `[Admin.tsx:ProfilePage]` requires non-empty `name`, `email`, and `jurisdiction` before committing edits; `[Admin.tsx:FollowUpsPage]` sorts follow-ups by status rank and disables completion on `"Realizado"` items.

## Side Effects
- `[vetkit.tsx:VetProvider]` calls `PATCH /api/users/profile`, `GET /api/consultations/mine`, `GET /api/prescriptions`, `PATCH /api/consultations/${id}/assign`, and `PATCH /api/consultations/${id}/complete`, invalidates React Query `['consultations']`, listens to Socket.IO `consultation:new`, reads/writes `localStorage` (`huellicam_vet_rx`), and schedules toast removal timers.
- `[vetkit.tsx:ChatPanel]` and `[CallRoom.tsx:CallChatPanel]` join/leave Socket.IO consultation rooms, subscribe to `message:new`, emit `message:send`, call `GET/POST /api/consultations/${id}/messages` and `POST /api/media`, allocate preview URLs via `URL.createObjectURL`, and scroll via `scrollIntoView`.
- `[CallRoom.tsx:Room]` executes `GET /api/consultations/${id}`, `PATCH /api/consultations/${id}/assign`, `POST /api/calls/${id}/token`, `PATCH /api/consultations/${id}/complete`, and `PATCH /api/consultations/${id}/cancel`, invalidates React Query `["consultation", id]` and `["consultations"]`, handles Socket.IO lifecycle events (`connect`, `call:ended`, `consultation:assigned`, `consultation:cancelled`, `consultation:critical_resume`, `notification:new`), emits `call:ended`, connects `LiveKitRoom` (`[CallRoom.tsx:LiveKitTrackSynchronizer]`), reads `localStorage` (`huellicam_user`), requests `navigator.mediaDevices.getUserMedia`, acquires/releases `navigator.wakeLock`, sends React Native bridge events via `postMobileBridgeMessage`, and drives timers/`requestAnimationFrame`/Web Animations API in `[CallRoom.tsx:WaitingRoomExperience]`.
- `[VetApp.tsx:VetShell]` invokes `logout()`, sets `window.location.href = "/login"`, and navigates via `go()`; `[VetApp.tsx:AvailabilityControl]` attaches `document` `mousedown` and `keydown` listeners while open.
- `[vetkit.tsx:WaitTimer]`, `[vetkit.tsx:Lightbox]`, and `[vetkit.tsx:Sheet]` manage a 1-second `setInterval`, `window` `keydown` listeners, and DOM focus restoration.
- `[Consultations.tsx:ConsultationsPage]` reads/writes `sessionStorage` (`vet_consultations_tab`, `vet_consultations_day`, `vet_consultations_kind`, `vet_consultations_mode`); `[Consultations.tsx:EvolutionEditor]` uses a 500ms `window.setTimeout` to append to local evolution state.
- `[Agenda.tsx:AppointmentsPage]` sends `PATCH /api/consultations/${consultId}/cancel` and invalidates React Query `["consultations"]` when cancelling consultation-backed events; rescheduling and `[Agenda.tsx:AvailabilityPage]` edits update local component state only.
- `[Prescriptions.tsx:NewPrescription]` posts to `POST /api/consultations/${consultationId}/prescriptions`, invalidates `["prescriptions", "vet"]`, and registers returned pets via `[Prescriptions.tsx:mapBackendRxToVetRx]` -> `[data.ts:registerPatient]`; `[Prescriptions.tsx:PrescriptionDetail]` fetches `GET /api/prescriptions/${id}` with `AbortController`, writes to `navigator.clipboard`, and navigates/opens `/prescriptions/${r.id}`.
- `[Admin.tsx:ProfilePage]` uploads avatar files via `POST /api/media` (falling back to `FileReader.readAsDataURL`) and updates profile fields via `PATCH /api/users/profile`.
- `[data.ts:registerPatient]` and `[data.ts:registerPatients]` mutate the module-level `[data.ts:dynamicPatients]` `Map`.

## Verification
- Run: `npm test -w web`
