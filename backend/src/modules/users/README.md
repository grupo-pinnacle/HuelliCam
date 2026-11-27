# Users Module

## Overview
Manages authenticated user profile updates, manual veterinarian availability status propagation, and authenticated password changes with token version rotation.

## Interface
- `[users.schemas.ts:updateProfileSchema]`: Zod schema validating optional `firstName`, `lastName`, `phone`, `bio`, `photoUrl`, and `isOnline`.
- `[users.schemas.ts:changePasswordSchema]`: Zod schema validating `currentPassword` (1–128 chars) and `newPassword` (8–128 chars).
- `[users.schemas.ts:UpdateProfileDTO]`: Inferred DTO type for profile updates.
- `[users.schemas.ts:ChangePasswordDTO]`: Inferred DTO type for password changes.
- `[users.routes.ts:default]`: Express `Router` applying `authenticate` globally with `PATCH /profile` and `PATCH /password`.
- `[users.controller.ts:UsersController]`: Controller exposing `updateProfile` and `changePassword`.
- `[users.service.ts:UsersService]`: Service exposing `updateProfile` and `changePassword`.

## Invariants
- `[users.routes.ts:default]`: All user routes require an authenticated user (`authenticate`).
- `[users.schemas.ts:updateProfileSchema]`: `phone` must match `PHONE_REGEX` with 7–15 digits (empty string normalizes to `null`); `bio` (max 500 chars) and `photoUrl` (valid URL max 500 chars) normalize empty strings to `null`.
- `[users.service.ts:UsersService.updateProfile]`: Queries return only `userSelectFields` (omitting `password` and `tokenVersion`); setting `isOnline` to `false` updates `lastSeen` to `new Date()`.
- `[users.service.ts:UsersService.changePassword]`: Rejects missing or soft-deleted users (`404` `USER_NOT_FOUND`), verifies `currentPassword` with `bcrypt.compare` (throwing HTTP `400` `INVALID_CURRENT_PASSWORD` rather than `401`), hashes `newPassword` with bcrypt cost `12`, increments `tokenVersion`, and issues fresh tokens via `AuthService.generateTokens`.

## Side Effects
- `[users.service.ts:UsersService]`: Queries and updates `prisma.user` records in PostgreSQL.
- `[users.service.ts:UsersService.updateProfile]`: When `isOnline` is boolean, invokes `presenceService.setManualVetAvailability` and emits `'vet:presence'` Socket.IO events to room `'role:vets'` for `Role.VET` with `VetStatus.APPROVED` (errors caught as non-blocking).
- `[users.controller.ts:UsersController.changePassword]`: Writes the new refresh token cookie via `setRefreshCookie`.

## Verification
- Run: `npm test -w backend`
