# Auditoría Arquitectónica y Técnica del Backend — Huellicam

> **Alcance:** Inspección estática de arquitectura, contratos, concurrencia, seguridad y consistencia operativa sobre `backend/` (sin modificaciones de código).  
> **Fecha:** 2026-11-26

---

## 1. Arquitectura General Observada

- **Estructura**: Monolito modular en Express 5 + TypeScript ([app.ts](../../backend/src/app.ts), [server.ts](../../backend/src/server.ts)) con 9 módulos de dominio bajo `backend/src/modules/`, capa realtime en `backend/src/realtime/` (Socket.IO + `@socket.io/redis-adapter` + `PresenceService`), persistencia PostgreSQL vía Prisma ([schema.prisma](../../backend/prisma/schema.prisma)) y scheduler horario de recordatorios por correo ([notifications.scheduler.ts](../../backend/src/jobs/notifications.scheduler.ts)).
- **Puntos sólidos**:
  - Orden correcto de `express.raw` en `/api/calls/webhook` antes de `express.json()` para preservar el payload crudo en la verificación HMAC de LiveKit ([app.ts](../../backend/src/app.ts#L71-L74)).
  - Graceful shutdown ordenado (`disconnectQueue.flushAll()` -> `io.close()` -> `server.close()` -> `closeAllRedisClients()` -> `prisma.$disconnect()`) con timeout de fuerza de 10 s ([server.ts](../../backend/src/server.ts#L34-L112)).
  - Bloqueo estricto de `InMemoryAdapter` en producción cuando falta o falla Redis ([socket.server.ts](../../backend/src/realtime/socket.server.ts#L90-L97), [socket.server.ts](../../backend/src/realtime/socket.server.ts#L265-L293)).
  - Validación binaria por magic bytes, cuota diaria de subida y revocación de sesiones por `tokenVersion` en HTTP y WebSocket.

---

## 2. Huecos Arquitectónicos y Bugs Críticos / Altos

### 2.1. Máquina de estados y concurrencia desconectada del runtime (`ConsultationConcurrencyService` — resuelto)
- Histórico de auditoría: `ConsultationConcurrencyService` *(archivo `consultationConcurrency.service.ts` eliminado tras estandarizar a 4 estados en [consultations.service.ts](../../backend/src/modules/consultations/consultations.service.ts) y [consultation.contract.ts](../../backend/src/contracts/consultation.contract.ts))* implementaba `claimConsultationByVet`, `migrateTutorSession` y los estados extendidos (`TRIAGE_CRITICAL_QUEUED`, `CLAIM_PENDING_SYNC`, `LIVEKIT_CONNECTING`, `IN_CALL_ACTIVE`, `HANDOFF_IN_PROGRESS`), pero **`claimConsultationByVet` y `migrateTutorSession` no tenían ningún call site en producción** (solo se invocaban desde `__tests__/`).
- **Impacto histórico (resuelto en Fase 1-4):**
  - `Consultation.activeDeviceId` no se seteaba en runtime, por lo que `CallsService.generateLiveKitToken` ([calls.service.ts](../../backend/src/modules/calls/calls.service.ts)) caía al fallback `user.id` en lugar de `tutor_${user.id}:${activeDeviceId}`, rompiendo la expulsión en LiveKit SFU dentro de `handlePostCommitEvictionAndResume` *(consolidado ahora en [sessionEviction.helper.ts](../../backend/src/realtime/sessionEviction.helper.ts))*.
  - `ConsultationsService` y `CallsService` ahora operan estrictamente sobre los 4 estados clínicos (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`).
  - `checkVetDisconnectTimeout` ([consultations.service.ts](../../backend/src/modules/consultations/consultations.service.ts)) ahora cuenta con el sweeper distribuido en Redis ZSET ([vetDisconnectTracker.ts](../../backend/src/realtime/vetDisconnectTracker.ts)) además de la verificación en `getMine`.

### 2.2. Feature flags y pricing settings en memoria local (y sin enforcement)
- `FeatureFlagsService.flags` ([feature-flags.service.ts](../../backend/src/modules/admin/feature-flags.service.ts#L21-L70)) y `AdminService.currentPricingSettings` ([admin.service.ts](../../backend/src/modules/admin/admin.service.ts#L812-L850)) viven únicamente en memoria de proceso (sin tabla en [schema.prisma](../../backend/prisma/schema.prisma) ni respaldo en Redis), perdiéndose en cada reinicio y desincronizándose en múltiples réplicas.
- **`featureFlagsService.isEnabled` y `assertEnabled` no se invocan en ningún módulo de producción**, por lo que desactivar `VIDEOCALLS_ENABLED`, `TRIAGE_ACTIVE` o `NEW_REGISTRATIONS_ENABLED` desde `/api/admin/feature-flags` no bloquea los flujos reales.

### 2.3. Endpoint público de recetas sin firma ni control de borrado
- [prescriptions.routes.ts](../../backend/src/modules/prescriptions/prescriptions.routes.ts#L9) expone `GET /api/prescriptions/:id` sin autenticación ni firma HMAC de verificación.
- [prescriptions.service.ts](../../backend/src/modules/prescriptions/prescriptions.service.ts#L252-L281) devuelve el registro `pet` completo (`microchip`, `allergies`, `chronicConditions`, `birthDate`), `client` (`firstName`, `lastName`) y la prescripción sin verificar `consultation.deletedAt` ni firmar la URL de verificación (`verifyUrl` solo usa el UUID).

### 2.4. Estado de presencia y sesiones inconsistente entre DB, Socket.IO y logout
- `AuthService.logout` ([auth.service.ts](../../backend/src/modules/auth/auth.service.ts#L146-L154)) incrementa `tokenVersion` y marca `isOnline: false` en PostgreSQL, pero **no limpia Redis (`presenceService.clearUserPresence`) ni desconecta sockets activos**, dejando al usuario visible como online hasta que expire `PRESENCE_TTL_MS` (90 s).
- `socket.server.ts` actualiza presencia únicamente en Redis, mientras `AdminService.getStats` (cuando no detecta presencia distribuida) y consultas de fallback leen `User.isOnline` en PostgreSQL, manteniendo dos fuentes de verdad distintas.
- `AdminService.updateUser` ([admin.service.ts](../../backend/src/modules/admin/admin.service.ts#L317-L359)) no incrementa `tokenVersion` ni limpia presencia cuando un administrador modifica `role`, `vetStatus` o `password`.

---

## 3. Bugs Medios y Riesgos Operativos

### 3.1. Race condition en cuota diaria de uploads y endpoint fantasma en `pets`
- `MediaService.uploadMediaFile` ([media.service.ts](../../backend/src/modules/media/media.service.ts#L38-L138)) consulta `dailyUploadCounter` fuera de transacción, sube/mueve el archivo y recién después ejecuta `upsert`: subidas concurrentes pueden superar los 50 MB diarios, y un fallo en `prisma.mediaFile.create` deja objetos huérfanos en S3/disco con la cuota ya consumida.
- `uploadTmpDir` ([media.middleware.ts](../../backend/src/modules/media/media.middleware.ts#L8)) y `uploadsDir` ([media.service.ts](../../backend/src/modules/media/media.service.ts#L11)) resuelven contra `process.cwd()`, variando según se ejecute desde la raíz del monorepo o desde `backend/`.
- `POST /api/pets/:id/documents` ([pets.routes.ts](../../backend/src/modules/pets/pets.routes.ts#L13), [pets.controller.ts](../../backend/src/modules/pets/pets.controller.ts#L74-L98)) carece de middleware `multer`, no persiste en base de datos y devuelve un objeto sintético en memoria (`doc-${Date.now()}`, `'1.2 MB'`).

### 3.2. Rate limiters y bloqueos OTP en memoria de proceso
- `loginLimiter` / `registerLimiter` ([app.ts](../../backend/src/app.ts#L79-L105)), [rateLimiter.ts](../../backend/src/middlewares/rateLimiter.ts#L3-L65), `applySocketRateLimiting` y `PasswordResetService.failedAttemptsMap` ([passwordReset.service.ts](../../backend/src/modules/auth/passwordReset.service.ts#L8-L99)) almacenan contadores en memoria local por proceso en lugar de Redis. Ante múltiples réplicas o reinicios, el límite de 3 intentos fallidos de OTP y los rate limits se reinician.

### 3.3. Telemetría de llamadas y manejo silencioso de errores
- En `CallsService.handleWebhook` ([calls.service.ts](../../backend/src/modules/calls/calls.service.ts#L201-L256)), `participantCount` y `metadata.events` realizan read-modify-write no atómico ante webhooks concurrentes de LiveKit; aunque `CallStatus.FAILED` existe en [schema.prisma](../../backend/prisma/schema.prisma#L40), `room_aborted` y `track_publish_failed` nunca actualizan `call.status` a `FAILED`.
- `ConsultationsService.getMine` ([consultations.service.ts](../../backend/src/modules/consultations/consultations.service.ts#L527-L533)) captura cualquier error de PostgreSQL y devuelve `[]` con HTTP `200`, enmascarando fallos de base de datos.
- `ConsultationsService.assignConsultation` ([consultations.service.ts](../../backend/src/modules/consultations/consultations.service.ts#L219-L228)) auto-aprueba en DB (`vetStatus: APPROVED`) a cualquier veterinario fuera de `production`, pudiendo ocultar errores de permisos en staging/QA.
- `AdminService.revokeUserSessionsAndSuspend` ([admin.service.ts](../../backend/src/modules/admin/admin.service.ts#L763-L768)) invoca `(prisma as any).refreshToken?.deleteMany`, pero el modelo `RefreshToken` no existe en [schema.prisma](../../backend/prisma/schema.prisma) (`revokedCount` siempre es `0`).
