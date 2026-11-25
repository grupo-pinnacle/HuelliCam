# Referencia Técnica del Sistema — Huellicam

Documentación técnica de bajo nivel sincronizada con `backend/prisma/schema.prisma`, los routers de Express (`backend/src/app.ts`) y los contratos de tiempo real (`backend/src/realtime/socket.types.ts`).

---

## 1. Modelo de Datos (Prisma ORM 6 — PostgreSQL 16)

El esquema actual en [schema.prisma](../backend/prisma/schema.prisma) define **4 enums** y **15 modelos**:

### 1.1 Enums
- **`Role`:** `CLIENT` | `VET` | `ADMIN`
- **`VetStatus`:** `PENDING` | `APPROVED` | `REJECTED`
- **`CallStatus`:** `INITIATED` | `ACTIVE` | `ENDED` | `FAILED`
- **`ConsultationStatus`:**
  - Flujo principal: `WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`
  - Estados de concurrencia y recuperación de sesión: `TRIAGE_CRITICAL_QUEUED`, `CLAIM_PENDING_SYNC`, `LIVEKIT_CONNECTING`, `IN_CALL_ACTIVE`, `AWAITING_EMERGENCY_CALLBACK`, `HANDOFF_IN_PROGRESS`

### 1.2 Los 15 Modelos Canónicos

| Modelo | Tabla SQL | Responsabilidad Principal |
|---|---|---|
| `User` | `users` | Cuentas (`CLIENT`, `VET`, `ADMIN`), estado de matrícula (`vetStatus`, `licenseNumber`), presencia (`isOnline`, `lastSeen`), `tokenVersion`, reputación denormalizada (`ratingAvg`, `ratingCount`) y soft-delete (`deletedAt`). |
| `Pet` | `pets` | Ficha declarativa de mascota (`name`, `species`, `breed`, `weightKg`, `sex`, `birthDate`, `microchip`, `allergies`, `chronicConditions`) con soft-delete. |
| `Consultation` | `consultations` | Ciclo clínico de atención, notas de triaje, `diagnosisNotes`, timestamps, y campos de concurrencia (`activeDeviceId`, `transportStatus`, `stateVersion`, `claimedAt`, `livekitRoomSid`). |
| `ConsultationAuditLog` | `consultation_audit_log` | Trazabilidad granular de transiciones, reclamos, desconexiones y handoff por dispositivo sobre una consulta. |
| `Message` | `messages` | Mensajes del chat clínico con clave única de idempotencia (`clientMsgId`) y adjunto opcional (`attachmentUrl`). |
| `Call` | `calls` | Registro de salas de videollamada (`roomName`, `livekitRoomSid`, `status`, `startedAt`, `endedAt`, `durationSeconds`, `participantCount`, `errorCode`, `errorMessage`, `disconnectReason`, `lastEvent`, `metadata`). |
| `Prescription` | `prescriptions` | Recetas médicas digitales emitidas por el veterinario (`medication`, `dosage`, `frequency`, `durationDays`, `indications`). |
| `Review` | `reviews` | Calificación única por consulta (`1..5` estrellas) y comentario opcional. |
| `AuditLog` | `audit_logs` | Auditoría inmutable de acciones administrativas (aprobación/rechazo SENASA, CRUDs, revocación de sesiones, cambio de feature flags y tarifas). |
| `DailyUploadCounter` | `daily_upload_counters` | Cuota diaria de subidas por usuario (`date` `YYYY-MM-DD`, `count`, `totalBytes` con tope 50 MB/día). |
| `MediaFile` | `media_files` | Metadatos de archivos clínicos en almacenamiento local o S3 (`fileName`, `fileSize`, `mimeType`, `localPath`, `s3Key`, `deletedAt`). |
| `PushToken` | `push_tokens` | Tokens de dispositivos registrados para Expo Push Notifications (`token`, `platform`: `ios \| android \| web`). |
| `Notification` | `notifications` | Bandeja de notificaciones in-app (`title`, `body`, `type`, `data`, `isRead`, `readAt`). |
| `PasswordResetToken` | `password_reset_tokens` | Códigos OTP de 6 dígitos hasheados (`codeHash`) con expiración (`expiresAt`) y control de un solo uso (`usedAt`). |
| `EmailDispatchLog` | `email_dispatch_logs` | Deduplicación persistente (`dedupeKey` único) de correos automáticos (`APPOINTMENT`, `CHECKUP`, `BIRTHDAY`). |

---

## 2. Contratos de API REST

Prefijo base de la API: `/api` (más endpoint de salud `GET /health`). Todas las entradas se validan con **Zod** y los errores siguen el envelope estándar `{ success: false, error: { code, message, details, timestamp } }`.

### 2.1 Autenticación (`/api/auth`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `POST` | `/api/auth/register` | Registro de `CLIENT` o `VET` (los `VET` inician en `PENDING`). | Público |
| `POST` | `/api/auth/login` | Login. Web recibe cookie `HttpOnly` de refresh; Mobile (`X-Client-Platform: mobile`) recibe `refreshToken` en el body. | Público |
| `POST` | `/api/auth/refresh` | Renovación de `accessToken` desde cookie o body `{ refreshToken }`. | Público |
| `POST` | `/api/auth/logout` | Cierre de sesión e incremento de `tokenVersion`. | Autenticado |
| `GET` | `/api/auth/me` | Retorna perfil actualizado del usuario autenticado. | Autenticado |
| `POST` | `/api/auth/forgot-password` | Envía código OTP de 6 dígitos al correo (expira en 15 min). | Público |
| `POST` | `/api/auth/verify-reset-code` | Valida código OTP vigente para un email. | Público |
| `POST` | `/api/auth/reset-password` | Actualiza contraseña e invalida sesiones previas (`tokenVersion`). | Público |

### 2.2 Usuarios (`/api/users`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `PATCH` | `/api/users/profile` | Actualiza `firstName`, `lastName`, `phone`, `bio`, `photoUrl` y disponibilidad `isOnline`. | Autenticado |
| `PATCH` | `/api/users/password` | Cambio de contraseña autenticado validando `currentPassword` y rotando sesión. | Autenticado |

### 2.3 Mascotas (`/api/pets`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `POST` | `/api/pets` | Crea ficha declarativa (`name`, `species`, `breed`, `weightKg`, `sex`, `birthDate`, `microchip`, `allergies`, `chronicConditions`). | Autenticado |
| `GET` | `/api/pets` | Lista mascotas activas del usuario autenticado. | Autenticado |
| `GET` | `/api/pets/:id` | Detalle e historial clínico de la mascota. | Dueño / Vet / ADMIN |
| `POST` | `/api/pets/:id/documents` | Registra metadatos de un documento clínico asociado a la mascota. | Dueño / Vet / ADMIN |
| `PATCH` | `/api/pets/:id` | Actualiza datos declarativos de la mascota sin alterar consultas ni recetas. | Dueño / ADMIN |
| `DELETE` | `/api/pets/:id` | Soft-delete (`deletedAt`). | Dueño / ADMIN |

### 2.4 Consultas, Mensajes y Reseñas (`/api/consultations`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `POST` | `/api/consultations` | Crea consulta (`petId`, `notes`, `symptoms?`, `duration?`), ejecuta evaluación de triaje y la coloca en cola. | CLIENT |
| `GET` | `/api/consultations/mine` | Para `CLIENT`: sus consultas. Para `VET`: sus consultas asignadas + cola `WAITING`. Expira automáticamente consultas `WAITING` > 15 min. | Autenticado |
| `GET` | `/api/consultations/:id` | Detalle de consulta con mascota, mensajes, recetas y reseña. | Participantes / ADMIN |
| `PATCH` | `/api/consultations/:id/assign` | Asigna la consulta al veterinario de guardia (`APPROVED`). | VET (Approved) |
| `PATCH` | `/api/consultations/:id/complete` | Cierra consulta `ACTIVE` con `diagnosisNotes`, cierra sala LiveKit y emite `call:ended`. | VET asignado / ADMIN |
| `PATCH` | `/api/consultations/:id/cancel` | Cancela consulta con motivo opcional y libera sala LiveKit. | Participantes / ADMIN |
| `POST` | `/api/consultations/:id/review` | Registra calificación (`1..5`) y recalcula `ratingAvg` / `ratingCount` atómicamente. | CLIENT asignado |
| `GET` | `/api/consultations/:id/messages` | Historial de chat y sincronización incremental (`?after={ISO_TIMESTAMP}`). | Participantes / ADMIN |
| `POST` | `/api/consultations/:id/messages` | Envío REST alternativo de mensaje con deduplicación por `clientMsgId`. | Participantes / ADMIN |

### 2.5 Recetas Digitales (`/api/prescriptions` y `/api/consultations/:id/prescriptions`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `GET` | `/api/prescriptions/:id` | Verificación pública de receta médica (usada al escanear el código QR). | Público |
| `GET` | `/api/prescriptions` | Listado de recetas del tutor o emitidas por el veterinario autenticado. | Autenticado |
| `POST` | `/api/consultations/:id/prescriptions` | Emite receta digital (`medication`, `dosage`, `frequency`, `durationDays`, `indications`), genera QR y envía email. | VET asignado |

### 2.6 Videollamadas (`/api/calls`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `POST` | `/api/calls/webhook` | Webhook firmado con HMAC SHA256 de LiveKit (`room_started`, `participant_joined`, `participant_left`, `participant_connection_aborted`, `room_finished`) que actualiza telemetría en `Call`. | LiveKit Webhook (HMAC) |
| `POST` | `/api/calls/:consultationId/token` | Genera JWT LiveKit (`identity: user.id` o compuesto por dispositivo, `name: user.firstName`) y `wsUrl` persistiendo `Call` (`INITIATED`). Requiere estado `ACTIVE`. | Participantes / ADMIN |
| `POST` | `/api/calls/:consultationId/ring` | Emite `call:incoming` vía Socket.io, asegura registro `Call` y envía notificación push al par. | Participantes / ADMIN |

### 2.7 Archivos Médicos (`/api/media`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `POST` | `/api/media` | Subida multipart (`file`), validación binaria de *Magic Bytes* (JPEG, PNG, PDF), tope 10 MB/archivo y 50 MB/día (`DailyUploadCounter`). | Autenticado |
| `GET` | `/api/media/:id` | Descarga protegida: retorna URL prefirmada (300s) en S3 o stream local previa verificación de permisos. | Participantes / ADMIN |

### 2.8 Notificaciones (`/api/notifications`)

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| `POST` | `/api/notifications/register-token` | Registra o actualiza `PushToken` (`ios`, `android`, `web`). | Autenticado |
| `GET` | `/api/notifications` | Lista las últimas notificaciones in-app del usuario. | Autenticado |
| `PATCH` | `/api/notifications/read-all` | Marca todas las notificaciones del usuario como leídas. | Autenticado |
| `PATCH` | `/api/notifications/:id/read` | Marca una notificación específica como leída. | Autenticado |

### 2.9 Administración (`/api/admin` — Requiere `Role.ADMIN`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/admin/stats` | Métricas de veterinarios, mascotas y consultas por estado. |
| `GET` | `/api/admin/audit-logs` | Últimos 100 registros de `AuditLog`. |
| `GET` | `/api/admin/vets/pending` | Cola de veterinarios con `vetStatus = PENDING`. |
| `PATCH` | `/api/admin/vets/:id/approve` | Aprueba matrícula profesional y audita la operación. |
| `PATCH` | `/api/admin/vets/:id/reject` | Rechaza matrícula con `reason` obligatorio y audita. |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/admin/users`, `/api/admin/users/:id` | Gestión completa de usuarios, `/ban`, `/restore` y `POST /api/admin/users/:id/revoke-sessions`. |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/admin/pets`, `/api/admin/pets/:id` | Gestión administrativa de mascotas y `/restore`. |
| `GET` | `/api/admin/consultations`, `/api/admin/consultations/:id/messages` | Supervisión operativa de consultas y lectura de mensajes. |
| `GET` / `PATCH` | `/api/admin/feature-flags` | Consulta y activación/desactivación auditada de flags (`PAYMENTS_ENABLED`, `TRIAGE_ACTIVE`, `VIDEOCALLS_ENABLED`, `NEW_REGISTRATIONS_ENABLED`). |
| `GET` | `/api/admin/executive-metrics` | Cálculo de GMV, comisión neta, pérdida por cancelaciones y tasa de conversión sobre consultas. |
| `GET` / `PATCH` | `/api/admin/pricing-settings` | Lectura y actualización del arancel base, take-rate (`0..1`) y moneda (`ARS`, `USD`, `BRL`, `MXN`, `EUR`). |

---

## 3. Eventos en Tiempo Real (Socket.io)

Definidos en `backend/src/realtime/socket.types.ts` y atendidos en `socket.server.ts` / `chat.gateway.ts`. El socket autentica el JWT en el handshake y suscribe automáticamente al usuario a `user:{userId}`, `device:{deviceId}` (si envía `x-device-id`) y `role:vets` (para `VET` y `ADMIN`).

### Cliente → Servidor
- `join:consultation` `{ consultationId }` — Suscribe a la sala `consultation:{id}` previa verificación de participación.
- `leave:consultation` `{ consultationId }` — Abandona la sala de la consulta.
- `message:send` `{ consultationId, content, clientMsgId, attachmentUrl? }` — Persiste y retransmite mensaje de forma idempotente (con callback ACK).
- `call:answered` `{ consultationId }` — Notifica atención de videollamada en la sala.
- `call:rejected` `{ consultationId, reason? }` — Cancela el timbrado.
- `call:ended` `{ consultationId }` — Notifica fin de llamada en la sala.

### Servidor → Cliente
- `message:new` — Broadcast del mensaje persistido a la sala de la consulta.
- `consultation:new` — Notifica a `role:vets` el ingreso de una nueva consulta en cola (redactando `email` y `phone` del tutor).
- `call:incoming` `{ consultationId, callerName, roomName }` — Alerta entrante en Web y Mobile.
- `call:ended` `{ consultationId, endedBy? }` — Cierre de llamada.
- `notification:new` — Entrega en vivo de una nueva `Notification` persistida.
- `auth:session_terminated` `{ reason, message }` — Notifica revocación de sesión desde panel admin o cambio crítico.
- `session:invalidated` / `consultation:critical_resume` / `consultation:tutor_reconnecting` — Eventos de migración y handoff multidispositivo durante consultas activas.
- `prescription:new` — Tipo declarado en `ServerToClientEvents` para evolución futura (hoy la notificación de receta se envía por correo y consulta REST).

---

## 4. Bundler Mobile y Pruebas

- **Singleton React en Metro (`mobile/metro.config.js`):** Bloquea la resolución hacia `node_modules/react` de la raíz (React 18.3.1 usado por `web/`) y fuerza toda importación de `react`, `react-dom` y `react-native` hacia `mobile/node_modules/` (React 19.1.0 / RN 0.81.4).
- **Suites de Verificación:**
  - `npm run check:governance` — Verifica sincronización entre `schema.prisma`, enlaces locales y documentación.
  - `npm run typecheck` — Validación `tsc --noEmit` en `backend`, `web` y `mobile`.
  - `npm test -w backend` — Suite Jest + Supertest.
  - `npm test -w web` — Suite Vitest + Testing Library.
  - `npm test -w mobile` — Suite Jest + `jest-expo`.
