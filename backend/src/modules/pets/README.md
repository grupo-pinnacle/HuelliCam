# Pets Module

## Overview
Manages authenticated pet profile lifecycle (create, list, retrieve, update, and soft-delete), enforces microchip uniqueness and physiological validation bounds, redacts owner PII when non-treating veterinarians inspect a pet, and builds transient clinical document responses.

## Interface
- `[pets.schemas.ts:birthDateSchema]`: Zod preprocessor and validator parsing date-only (`YYYY-MM-DD`) or timestamp strings and bounding dates between `1900-01-01T00:00:00.000Z` and end of current UTC day.
- `[pets.schemas.ts:createPetSchema]`: Zod schema for pet creation (`name`, `species`, `breed`, optional `weightKg`, `sex`, `birthDate`, `microchip`, `allergies`, `chronicConditions`).
- `[pets.schemas.ts:updatePetSchema]`: Partial Zod schema derived from `createPetSchema`.
- `[pets.schemas.ts:CreatePetDTO]`: Inferred DTO type for pet creation.
- `[pets.schemas.ts:UpdatePetDTO]`: Inferred DTO type for pet updates.
- `[pets.routes.ts:default]`: Express `Router` applying `authenticate` globally with `POST /`, `GET /`, `GET /:id`, `POST /:id/documents`, `PATCH /:id`, and `DELETE /:id`.
- `[pets.controller.ts:PetsController]`: Controller exposing `create`, `listMine`, `getById`, `update`, `delete`, and `uploadDocument`.
- `[pets.service.ts:PetsService]`: Service exposing `createPet`, `getPetsByOwner`, `getPetById`, `updatePet`, and `deletePet`.

## Invariants
- `[pets.routes.ts:default]`: All pet routes require an authenticated user (`authenticate`).
- `[pets.schemas.ts:createPetSchema]`: `weightKg` must be positive and `<= 1500`; `microchip` must match `/^\d{15}$/` (15 ISO numeric digits).
- `[pets.service.ts:PetsService.createPet]`: Active `microchip` values must be unique among non-soft-deleted pets (`deletedAt: null`), throwing `409` `MICROCHIP_ALREADY_EXISTS` on conflict.
- `[pets.service.ts:PetsService.getPetById]`: Only non-soft-deleted pets (`deletedAt: null`) are returned (`404` `PET_NOT_FOUND`), and access is limited to `pet.ownerId`, `Role.ADMIN`, or `Role.VET` (`403` `FORBIDDEN`).
- `[pets.service.ts:PetsService.getPetById]`: When a `Role.VET` who is neither owner nor `Role.ADMIN` accesses a pet without a non-deleted `prisma.consultation` linking `vetId` and `petId`, `owner.email` and `owner.phone` are redacted to `'[REDACTED]'`.
- `[pets.service.ts:PetsService.updatePet]`: Only `pet.ownerId` or `Role.ADMIN` may update a pet (`403` `FORBIDDEN`); changing `microchip` re-enforces uniqueness (`409` `MICROCHIP_ALREADY_EXISTS`).
- `[pets.service.ts:PetsService.deletePet]`: Only `pet.ownerId` or `Role.ADMIN` may delete a pet (`403` `FORBIDDEN`), performing a soft delete via `deletedAt`.
- `[pets.controller.ts:PetsController.uploadDocument]`: Verifies access via `petsService.getPetById` and returns a synthesized document metadata payload without persisting to the database.

## Side Effects
- `[pets.service.ts:PetsService]`: Queries, creates, updates, and soft-deletes `prisma.pet` records and queries `prisma.consultation` in PostgreSQL.

## Verification
- Run: `npm test -w backend`
