# Admin

## Overview
Administrative operations module providing role-restricted endpoints, validation schemas, service logic, runtime feature flags, session revocation, white-label pricing configuration, executive metrics, and veterinary verification workflows.

## Interface
- `[admin.routes.ts:default]` — Express `Router` enforcing `authenticate` and `requireRole(Role.ADMIN)` across `/stats`, `/audit-logs`, `/vets/pending`, `/vets/:id/approve`, `/vets/:id/reject`, `/users`, `/users/:id`, `/users/:id/ban`, `/users/:id/restore`, `/users/:id/revoke-sessions`, `/pets`, `/pets/:id`, `/pets/:id/restore`, `/consultations`, `/consultations/:id/messages`, `/feature-flags`, `/executive-metrics`, and `/pricing-settings`
- `[admin.controller.ts:AdminController]` — HTTP controller (`getStats`, `getPendingVets`, `approveVet`, `rejectVet`, `getUsers`, `createUser`, `updateUser`, `deleteUser`, `banUser`, `restoreUser`, `getPets`, `createPet`, `updatePet`, `deletePet`, `restorePet`, `getConsultations`, `getConsultationMessages`, `getAuditLogs`, `getFeatureFlags`, `toggleFeatureFlag`, `revokeUserSessions`, `getExecutiveMetrics`, `getPricingSettings`, `updatePricingSettings`)
- `[admin.service.ts:AdminService]` — Core admin service (`getStats`, `getPendingVets`, `approveVet`, `rejectVet`, `getUsers`, `createUser`, `updateUser`, `deleteUser`, `banUser`, `restoreUser`, `getPets`, `createPet`, `updatePet`, `deletePet`, `restorePet`, `getConsultations`, `getConsultationMessages`, `getAuditLogs`, `revokeUserSessionsAndSuspend`, `getPricingSettings`, `resetPricingForTests`, `updatePricingSettings`, `getExecutiveMetrics`)
- `[admin.service.ts:PricingSettingsResponse]`, `[admin.service.ts:ExecutiveMetricsResponse]` — Service response types
- `[feature-flags.service.ts:FeatureFlagsService]`, `[feature-flags.service.ts:featureFlagsService]`, `[feature-flags.service.ts:FeatureFlagItem]` — In-memory operational feature flag manager (`resetForTests`, `getAllFlags`, `isEnabled`, `assertEnabled`, `toggleFlag`)
- `[admin.schemas.ts:rejectVetSchema]`, `[admin.schemas.ts:adminCreateUserSchema]`, `[admin.schemas.ts:adminUpdateUserSchema]`, `[admin.schemas.ts:adminCreatePetSchema]`, `[admin.schemas.ts:adminUpdatePetSchema]`, `[admin.schemas.ts:updateFeatureFlagSchema]`, `[admin.schemas.ts:revokeUserSessionsSchema]`, `[admin.schemas.ts:updatePricingSettingsSchema]` — Zod request validation schemas
- `[admin.schemas.ts:FEATURE_FLAG_KEYS]`, `[admin.schemas.ts:SUPPORTED_CURRENCIES]` — Constant tuples for feature flags and currencies
- `[admin.schemas.ts:RejectVetDTO]`, `[admin.schemas.ts:AdminCreateUserDTO]`, `[admin.schemas.ts:AdminUpdateUserDTO]`, `[admin.schemas.ts:AdminCreatePetDTO]`, `[admin.schemas.ts:AdminUpdatePetDTO]`, `[admin.schemas.ts:FeatureFlagKey]`, `[admin.schemas.ts:UpdateFeatureFlagDTO]`, `[admin.schemas.ts:RevokeUserSessionsDTO]`, `[admin.schemas.ts:SupportedCurrency]`, `[admin.schemas.ts:UpdatePricingSettingsDTO]` — Inferred DTO and union types

## Invariants
- `[admin.routes.ts:router]` — Every route in this module requires authenticated `Role.ADMIN` access via `authenticate` and `requireRole(Role.ADMIN)`.
- `[admin.service.ts:AdminService.approveVet]`, `[admin.service.ts:AdminService.rejectVet]` — Vet approval and rejection update `vetStatus` and insert an `auditLog` record atomically inside `prisma.$transaction`; `rejectVet` also sets `isOnline: false` and increments `tokenVersion`.
- `[admin.service.ts:AdminService.createUser]`, `[admin.service.ts:AdminService.updateUser]` — User emails are normalized (`trim().toLowerCase()`) and must be unique (`409` `EMAIL_ALREADY_EXISTS`); passwords are hashed with `bcrypt` cost `12`.
- `[admin.service.ts:AdminService.createPet]`, `[admin.service.ts:AdminService.updatePet]`, `[admin.schemas.ts:adminCreatePetSchema]` — Pet `microchip` values must match 15 ISO numeric digits (`/^\d{15}$/`) and be unique among non-deleted pets (`409` `MICROCHIP_ALREADY_EXISTS`).
- `[admin.service.ts:AdminService.banUser]`, `[admin.service.ts:AdminService.deleteUser]`, `[admin.service.ts:AdminService.revokeUserSessionsAndSuspend]` — `deleteUser` delegates to `banUser`; banning/revoking increments `tokenVersion` and, when suspended (`suspendAccount` defaults to `true`), sets `deletedAt` and `isOnline: false`.
- `[feature-flags.service.ts:FeatureFlagsService.assertEnabled]`, `[admin.schemas.ts:FEATURE_FLAG_KEYS]` — All flags (`PAYMENTS_ENABLED`, `TRIAGE_ACTIVE`, `VIDEOCALLS_ENABLED`, `NEW_REGISTRATIONS_ENABLED`) initialize to `true` in memory; `assertEnabled` throws `AppError` (`503` `SERVICE_UNAVAILABLE`) when disabled.
- `[admin.schemas.ts:updatePricingSettingsSchema]`, `[admin.service.ts:AdminService.defaultPricingSettings]` — Pricing requires `baseConsultationFee` in `(0, 10000000]`, `platformTakeRate` in `[0, 1]`, and `currency` in `ARS | USD | BRL | MXN | EUR` (default `15000`, `0.2`, `'ARS'`).

## Side Effects
- `[admin.service.ts:AdminService]`, `[feature-flags.service.ts:FeatureFlagsService.toggleFlag]` — Reads/writes PostgreSQL tables via Prisma (`user`, `pet`, `consultation`, `message`, `auditLog`, and optional `refreshToken.deleteMany`).
- `[feature-flags.service.ts:FeatureFlagsService]`, `[admin.service.ts:AdminService.updatePricingSettings]` — Mutates in-memory `FeatureFlagsService.flags` Map and static `AdminService.currentPricingSettings`.
- `[admin.service.ts:AdminService.getStats]`, `[admin.service.ts:AdminService.getUsers]`, `[admin.service.ts:AdminService.getConsultations]`, `[admin.service.ts:AdminService.banUser]`, `[admin.service.ts:AdminService.rejectVet]`, `[admin.service.ts:AdminService.revokeUserSessionsAndSuspend]` — Queries or clears distributed Redis/presence state via `presenceService`.
- `[admin.service.ts:AdminService.rejectVet]`, `[admin.service.ts:AdminService.banUser]`, `[admin.service.ts:AdminService.revokeUserSessionsAndSuspend]`, `[admin.service.ts:AdminService.disconnectUserSocketsAfterFlush]` — Emits Socket.IO `auth:session_terminated` and `vet:presence` events, leaves `role:vets`, and schedules socket disconnection after 25ms (`unref` timer).

## Verification
- Run: `npm test -w backend`
