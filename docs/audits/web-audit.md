# Auditoría Arquitectónica, Técnica y de Contratos Web — Huellicam

> **Alcance:** Inspección estática de `web/` (arquitectura, bugs, contratos HTTP/Socket.IO, seguridad y resiliencia) y cruce directo con [backend-audit.md](./backend-audit.md). `mobile/` queda fuera de alcance. Sin modificaciones de código.  
> **Fecha:** 2026-11-26

---

## 1. Bugs Críticos / Bloqueantes en `web/`

### 1.1. Endpoint roto de cancelación en agenda del tutor (`404`)
- **Ubicación**: [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L1650-L1654) (`AppointmentsCalendar.cancelMutation`) vs [consultations.routes.ts](../../backend/src/modules/consultations/consultations.routes.ts#L16).
- **Hallazgo**: `cancelMutation` invoca `PATCH /api/consultations/${consId}/status` con `{ status: 'CANCELLED' }`. Esa ruta no existe en el backend (el endpoint real es `PATCH /api/consultations/:id/cancel`), por lo que toda cancelación desde el calendario del tutor falla con HTTP `404`.

### 1.2. `vet/CallRoom.tsx` permite al tutor llamar `/complete` (`403`) y rompe `ReviewModal`
- **Ubicación**: [CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L1316-L1349) (`handleFinalize`), [CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L1520-L1534) (`LiveKitRoom.onDisconnected`), [CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L1076-L1142) vs [consultations.service.ts](../../backend/src/modules/consultations/consultations.service.ts#L324-L337) y [chat.gateway.ts](../../backend/src/realtime/gateways/chat.gateway.ts#L103-L112).
- **Hallazgo**:
  - Cuando `fromClient === true` (`CLIENT`), al pulsar finalizar o tras 15 s de desconexión transitoria de LiveKit, `handleFinalize` invoca `PATCH /api/consultations/${targetId}/complete` (exclusivo de `VET`/`ADMIN`, rechazado con `403 FORBIDDEN`).
  - El error se silencia en `catch`, se emite igual `call:ended` por Socket.IO (`chat.gateway.ts` lo retransmite a toda la sala), ambos participantes pasan a `callState = "ended"` y se abre `ReviewModal` cuyo `POST /api/consultations/:id/review` falla con `400 CONSULTATION_NOT_COMPLETED` porque la consulta sigue `ACTIVE` en PostgreSQL.
  - Además, `isConsultationActive` (`CallRoom.tsx:1076-1077`) acepta `ACTIVE` o `IN_CALL_ACTIVE`, pero el fetch de token LiveKit (`CallRoom.tsx:1142`) solo se ejecuta si `consultation?.status === "ACTIVE"`.

### 1.3. Adjuntos de chat en `ClientApp.tsx` sin persistencia y `/api/media/:id` roto por auth
- **Ubicación**: [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L1846-L2188), [Admin.tsx](../../web/src/vet/Admin.tsx#L72-L95), [CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L596-L619), [CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L830-L852), [vetkit.tsx](../../web/src/vet/vetkit.tsx#L609-L656), `ConsultationRoom.tsx` *(eliminado en remediación)*, [AdminApp.tsx](../../web/src/pages/AdminApp.tsx#L1848-L1857) vs [media.routes.ts](../../backend/src/modules/media/media.routes.ts#L10), [auth.middleware.ts](../../backend/src/modules/auth/auth.middleware.ts#L21-L32), [auth.controller.ts](../../backend/src/modules/auth/auth.controller.ts#L25-L34), [media.service.ts](../../backend/src/modules/media/media.service.ts#L128-L140), [users.schemas.ts](../../backend/src/modules/users/users.schemas.ts#L35-L42).
- **Hallazgo**:
  - `MessagesPage.handleRealFileSelect` solo crea `URL.createObjectURL(file)` en estado local sin subir a `POST /api/media` ni enviar mensaje al backend; `handleAttachDoc` es código muerto sin uso y los mappers REST/Socket de `ClientApp` ignoran `attachmentUrl`.
  - `/api/media/:id` exige `Authorization: Bearer` o cookie `accessToken`, pero el backend solo emite cookie `refreshToken` con `path: '/api/auth'`. Por ello, `<img src="/api/media/${id}">` y `<a href="/api/media/${id}">` en `ConsultationRoom`, `AdminApp` y `ClinicalChatThread` fallan con `401`.
  - `vet/Admin.tsx` (`ProfilePage.handlePhotoUpload`) lee `uploadRes.data?.data?.url || localPath`, pero `MediaFile` no tiene `url` (`types/index.ts:151`) y `localPath` o el fallback `data:` base64 violan `updateProfileSchema.photoUrl`.
  - `vet/CallRoom.tsx` y `vet/vetkit.tsx` capturan fallos de `POST /api/media` (ej. `429` cuota o `400` magic bytes) y envían igual el texto `"📎 Adjunto: ..."` sin `attachmentUrl`.

### 1.4. Exposición XSS del JWT en `localStorage`, carrera de `800 ms` en logout y fuga de caché
- **Ubicación**: [api.ts](../../web/src/services/api.ts#L20-L40), [AuthContext.tsx](../../web/src/context/AuthContext.tsx#L42-L131), [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L3478-L3489) (`SettingsPage.handleLogout`), [App.tsx](../../web/src/App.tsx#L45-L184).
- **Hallazgo**:
  - `api.ts` persiste `huellicam_token` en `window.localStorage` y `AuthContext` persiste `huellicam_user`, exponiendo el Bearer JWT ante cualquier XSS; además, `AuthContext` retiene el usuario cacheado si `/api/auth/me` falla por errores no-401/403.
  - `SettingsPage.handleLogout` compite `logout()` contra un timeout de `800 ms` antes de redirigir por `window.location.href = '/login'`, pudiendo abortar `POST /api/auth/logout` antes de rotar `tokenVersion` o limpiar estado.
  - `clearSession()` (`AuthContext.tsx:56-66`) no invoca `queryClient.clear()`, elimina `huellicam_device_id` en cada cierre de sesión (forzando nuevo `deviceId` en cada login) y deja huérfanas las claves `huellicam_vaccines_*`, `huellicam_docs_*`, `huellicam_chat_*`, `huellicam_vet_rx` y `huellicam_new_pet_draft` entre cuentas distintas en el mismo navegador.

---

## 2. Bugs Altos y Riesgos Arquitectónicos

### 2.1. Tres implementaciones de CallRoom y portales duplicados sin rutear
- **Ubicación**: [App.tsx](../../web/src/App.tsx#L16-L231), [CallRoom.tsx](../../web/src/vet/CallRoom.tsx), `ConsultationRoom.tsx` *(eliminado)*, `components/call/CallRoom.tsx` *(eliminado)*, [PreJoinModal.tsx](../../web/src/components/call/PreJoinModal.tsx), `DashboardClient.tsx` *(eliminado)*, `DashboardVet.tsx` *(eliminado)*, `AdminVets.tsx` *(eliminado)*, [AuthExperience.tsx](../../web/src/pages/AuthExperience.tsx), `Login.tsx` *(eliminado)*, `Register.tsx` *(eliminado)*, [ProtectedRoute.tsx](../../web/src/routes/ProtectedRoute.tsx).
- **Hallazgo**:
  - `App.tsx` rutea `/call/:id` únicamente a `vet/CallRoom.tsx` (1,622–1,755 líneas), dejando sin ruta en producción a `pages/ConsultationRoom.tsx` y `components/call/CallRoom.tsx` (`PreJoinModal` no se usa en `/call/:id`).
  - Quedan sin ruta `DashboardClient.tsx` (usa especies `'Canine'`/`'Feline'` incompatibles con el draft compartido `'Perro'`/`'Gato'` de `ClientApp`), `DashboardVet.tsx`, `AdminVets.tsx` (autollena motivo de rechazo mientras `AdminApp` lo exige), `Login.tsx` y `Register.tsx`.
  - `ClientApp.tsx` (3,404+ líneas) y `AdminApp.tsx` (2,132+ líneas) son monolitos que mezclan navegación manual (`pushState` + `popstate`) con React Router, mientras `ProtectedRoute.tsx` no se utiliza en `App.tsx`.
  - `CallWrapper` (`App.tsx:88-91`) usa `'milo'` como fallback si falta `:id`.

### 2.2. Duplicación de mensajes en `ClientApp`, fallbacks peligrosos y bypass del triage backend
- **Ubicación**: [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L959-L1302), [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L2032-L2109), [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L3244-L3256) vs [clinicalTriage.engine.ts](../../backend/src/modules/consultations/clinicalTriage.engine.ts#L67-L79).
- **Hallazgo**:
  - `MessagesPage.handleNewMessage` deduplica solo por `id` y no por `clientMsgId`, duplicando en pantalla y en `localStorage` cada mensaje enviado optimísticamente al llegar por `message:new`.
  - `PetDetail` (`959`) y `ConsultationDetail` (`1570`) hacen fallback a `pets[0]` / `consultations[0]`, ocultando errores de ID inexistente; `editSex` (`974`) no se sincroniza con `pet.sex`.
  - `TriageResult.handleConnect` colapsa duraciones (`DAYS_1_TO_2`/`MORE_THAN_2_DAYS` nunca se envían), manda texto libre en lugar de `ClinicalSymptomKey` y antepone `[Prioridad: ...]` vía `formatConsultationNotes`, disparando el bypass `legacyMatch` en `clinicalTriage.engine.ts`.

### 2.3. Datos clínicos aislados en `localStorage`/memoria y defectos en `AdminApp.tsx`
- **Ubicación**: [ClientApp.tsx](../../web/src/pages/ClientApp.tsx#L1108-L1182), [Consultations.tsx](../../web/src/vet/Consultations.tsx#L121-L154), [Agenda.tsx](../../web/src/vet/Agenda.tsx#L37-L128), [Admin.tsx](../../web/src/vet/Admin.tsx#L9-L35), [AdminApp.tsx](../../web/src/pages/AdminApp.tsx#L330-L433).
- **Hallazgo**:
  - Vacunas (`huellicam_vaccines_*`), fotos de mascota (`huellicam_pet_photo_*`), evoluciones clínicas (`EvolutionEditor` con `setTimeout` de 500 ms), disponibilidad semanal (`Agenda.tsx`) y seguimientos (`Admin.tsx`) no persisten en PostgreSQL.
  - `AdminApp.handleConfirmBan` invoca `POST /revoke-sessions` (`suspendAccount: true`, silenciando errores) e inmediatamente `PATCH /ban`, duplicando mutaciones y registros de auditoría; `handleUpdatePricing` no refresca `AdminExecutiveMetrics` (al no pasarle prop `metrics`).

---

## 3. Hallazgos Medios

- **Bugs en código huérfano (`ConsultationRoom.tsx`)**: doble `useEffect` de WakeLock, errores de `fetchToken` leyendo `err.message` en vez de `err.response?.data?.error?.message`, y `onDisconnected` duplicando `call:ended` del bridge móvil.
- **`NotificationsPage` y `PrescriptionView.tsx`**: `markAllMutation` en `ClientApp.tsx` se dispara sin chequear `!markAllMutation.isPending`; [PrescriptionView.tsx](../../web/src/pages/PrescriptionView.tsx#L127-L130) no pasa `pet` a [PrescriptionDoc.tsx](../../web/src/components/ui/PrescriptionDoc.tsx#L137) (y `Prescription` en `types/index.ts` no tipa `consultation`), ocultando el bloque clínico del paciente; [Prescriptions.tsx](../../web/src/vet/Prescriptions.tsx#L83) (`NewPrescription`) puede elegir una consulta `WAITING` que el backend rechaza con `400 INVALID_STATUS`.

---

## 4. Matriz de Cruce de Contratos (`web/` vs `backend-audit.md`)

| Hallazgo en [backend-audit.md](./backend-audit.md) | Colisión exacta en `web/` y efecto en runtime |
|---|---|
| **§2.1 `ConsultationConcurrencyService` desconectado y `checkVetDisconnectTimeout` sin caller** | [types/index.ts](../../web/src/types/index.ts#L9-L19) declara los estados extendidos; [vet/CallRoom.tsx](../../web/src/vet/CallRoom.tsx#L1021-L1024) intenta `PATCH /assign` en `TRIAGE_CRITICAL_QUEUED`/`CLAIM_PENDING_SYNC` (backend devuelve `409`); `ClientApp` y `vet/mappers.ts` mapean esos estados como `"Cancelada"`; [GlobalCallListener.tsx](../../web/src/components/call/GlobalCallListener.tsx#L44-L60) y [SocketContext.tsx](../../web/src/context/SocketContext.tsx#L291-L296) escuchan `consultation:critical_resume` y `session:invalidated` que nunca se emiten; y si el vet cae sin cerrar consulta, la sala queda `ACTIVE` indefinidamente. |
| **§2.2 Feature flags y pricing en memoria sin enforcement** | [AdminFeatureFlagsModal.tsx](../../web/src/components/admin/AdminFeatureFlagsModal.tsx#L124) promete HTTP `503` al apagar módulos, pero ni [admin.service.ts](../../backend/src/modules/admin/admin.service.ts) / módulos backend ni `web/` bloquean flujos reales, y [AdminExecutiveMetrics.tsx](../../web/src/components/admin/AdminExecutiveMetrics.tsx#L168-L186) edita precios volátiles que se reinician a `15000 ARS / 0.2`. |
| **§2.3 `GET /api/prescriptions/:id` público sin firma HMAC ni `deletedAt`** | [App.tsx](../../web/src/App.tsx#L234-L235) y [PrescriptionView.tsx](../../web/src/pages/PrescriptionView.tsx#L13-L117) consumen `/api/prescriptions/:id` por UUID plano bajo `/prescriptions/:id` y `/verify-rx` exponiendo datos del paciente/tutor si se filtra el UUID. |
| **§2.4 Presencia/sesiones desincronizadas entre Redis, DB, logout y `updateUser`** | `AdminApp` y `AdminVets` muestran veterinarios como conectados hasta 90 s tras logout (agravado por la carrera de 800 ms en `ClientApp.SettingsPage.handleLogout`); cambios de `role`/`password` desde `AdminApp` no expulsan sesiones vivas en `SocketContext` ([SessionTerminatedModal.tsx](../../web/src/components/common/SessionTerminatedModal.tsx)). |
| **§3.1 Cuota de `/api/media` y endpoint fantasma `POST /api/pets/:id/documents`** | `ClientApp.PetDetail.handleAddDoc` envía JSON con DataURL base64 a `POST /api/pets/:id/documents` ([pets.controller.ts](../../backend/src/modules/pets/pets.controller.ts#L74-L98)), chocando con el límite `100kb` de `express.json` ([app.ts](../../backend/src/app.ts#L74)) y sin persistencia; `vet/CallRoom.tsx` y `vetkit.tsx` tragan `429`/`400` de `/api/media` y mandan mensajes sin archivo. |
| **§3.2 Rate limiters y bloqueo OTP en memoria** | `AuthExperience.ForgotPassword` no muestra intentos restantes; ante reinicios o múltiples réplicas backend el bloqueo de 3 intentos de OTP se reinicia transparentemente. |
| **§3.3 `getMine` devolviendo `[]` en error DB, `CallStatus.FAILED` omitido y `refreshToken.deleteMany` fantasma** | Ante caída de PostgreSQL, `ClientApp`, `vet/vetkit.tsx`, `DashboardClient` y `DashboardVet` borran las listas activas y muestran `"Sin consultas"` / `"¡Todo en calma!"` sin banner de error; `types/index.ts` omite `CallStatus: 'FAILED'`; `AdminApp` invoca `/revoke-sessions` cuyo `revokedCount` siempre es `0`. |
