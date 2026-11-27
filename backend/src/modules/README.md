# Modules

## Overview
Domain feature modules of the Huellicam backend, each organized into Zod schemas, Express routes, HTTP controllers, and domain services mounted by [../app.ts](../app.ts).

## Subdirectories & Boundaries
- Admin: [./admin/README.md](./admin/README.md) - Role-restricted (`Role.ADMIN`) user/pet/vet/consultation CRUD, audit logs, session revocation, white-label pricing settings, executive metrics, and in-memory feature flags.
- Auth: [./auth/README.md](./auth/README.md) - JWT access/refresh authentication, `tokenVersion` single-session concurrency, role middleware, HTTP-only refresh cookies, and 6-digit OTP password reset.
- Calls: [./calls/README.md](./calls/README.md) - LiveKit WebRTC token minting, incoming call ringing, room teardown, and HMAC-verified webhook telemetry ingestion.
- Consultations: [./consultations/README.md](./consultations/README.md) - Consultation lifecycle, deterministic clinical triage engine, real-time consultation chat, post-visit reviews, and optimistic CAS session/vet concurrency coordination.
- Media: [./media/README.md](./media/README.md) - Authenticated medical/consultation file uploads (Multer disk staging, magic-byte validation, 50 MB daily quota, local/S3 persistence) and authorized retrieval.
- Notifications: [./notifications/README.md](./notifications/README.md) - User notification persistence, read-state updates, Expo push token registration, and multi-channel dispatch via PostgreSQL, Socket.IO, and Expo Push API.
- Pets: [./pets/README.md](./pets/README.md) - Authenticated pet profile CRUD, soft deletion, 15-digit ISO microchip uniqueness, owner PII redaction for non-treating vets, and transient clinical document payloads.
- Prescriptions: [./prescriptions/README.md](./prescriptions/README.md) - Digital veterinary prescriptions with QR verification payloads, public QR verification (`GET /prescriptions/:id`), and multi-channel notifications.
- Users: [./users/README.md](./users/README.md) - Authenticated profile updates, manual veterinarian availability presence synchronization, and password rotation with `tokenVersion` increment.
