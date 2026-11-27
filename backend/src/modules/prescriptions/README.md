# Prescriptions Module

## Overview
Manages official digital veterinary prescriptions, including schema validation, veterinarian approval and consultation state checks, QR code verification URLs/data URLs, public third-party QR verification, and multi-channel notifications.

## Interface
- `[prescriptions.schemas.ts:createPrescriptionSchema]`: Zod schema validating `medication`, `dosage`, `frequency`, integer `durationDays` (`1`–`365`), and `indications`.
- `[prescriptions.schemas.ts:CreatePrescriptionDTO]`: Inferred DTO type from `createPrescriptionSchema`.
- `[prescriptions.routes.ts:default]`: Express `Router` exposing public `GET /prescriptions/:id` (`controller.getByIdPublic`), authenticated `GET /prescriptions` (`controller.getMyPrescriptions`), and authenticated `POST /consultations/:id/prescriptions` (`controller.create`).
- `[prescriptions.controller.ts:PrescriptionsController]`: Controller exposing `create`, `getById`, `getByIdPublic`, and `getMyPrescriptions`.
- `[prescriptions.service.ts:PrescriptionsService]`: Service exposing `createPrescription`, `getPrescriptionsForUser`, `getPrescriptionsForClient`, and `getPrescriptionById`.

## Invariants
- `[prescriptions.service.ts:PrescriptionsService.createPrescription]`: Only `Role.ADMIN` or `Role.VET` with `vetStatus === VetStatus.APPROVED` may issue prescriptions (`403` `FORBIDDEN` / `VET_NOT_APPROVED`).
- `[prescriptions.service.ts:PrescriptionsService.createPrescription]`: The target consultation must exist and not be soft-deleted (`404` `CONSULTATION_NOT_FOUND`), must belong to the issuing vet unless `Role.ADMIN` (`403` `FORBIDDEN`), and must be in `ConsultationStatus.ACTIVE` or `ConsultationStatus.COMPLETED` (`400` `INVALID_STATUS`).
- `[prescriptions.service.ts:PrescriptionsService.getPrescriptionsForUser]`: Scopes listed prescriptions to `vetId` for `Role.VET` and to `consultation.clientId` for other users, excluding soft-deleted consultations.
- `[prescriptions.routes.ts:default]`: `GET /prescriptions/:id` (`getByIdPublic`) allows unauthenticated third-party QR verification returning non-sensitive prescription, vet, pet, and client name data (`404` `PRESCRIPTION_NOT_FOUND` if missing).

## Side Effects
- `[prescriptions.service.ts:PrescriptionsService]`: Queries `prisma.consultation` and creates/queries `prisma.prescription` rows in PostgreSQL.
- `[prescriptions.service.ts:PrescriptionsService.buildQrPayload]`: Generates QR code data URLs via `QRCode.toDataURL` and logs generation errors via `logger.error`.
- `[prescriptions.service.ts:PrescriptionsService.createPrescription]`: Dispatches `PRESCRIPTION_NEW` notifications via `notificationsService.createAndDispatch`, emits `'prescription:new'` Socket.IO events to consultation/client/vet rooms, and sends prescription emails via `emailService.sendPrescriptionEmail` (logging failures via `logger.warn`).

## Verification
- Run: `npm test -w backend`
