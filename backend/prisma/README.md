# prisma

## Overview
Database schema definition, PostgreSQL datasource configuration, Prisma Client generator, ordered migrations, and development seed script for the Huellicam backend.

## Interface
- Datasource `db` (`provider = "postgresql"`, `DATABASE_URL`, `DIRECT_URL`) and generator `client` (`prisma-client-js`) `[schema.prisma:db]`, `[schema.prisma:client]`
- Enums: `Role` (`CLIENT`, `VET`, `ADMIN`) `[schema.prisma:Role]`, `VetStatus` (`PENDING`, `APPROVED`, `REJECTED`) `[schema.prisma:VetStatus]`, `ConsultationStatus` (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`) `[schema.prisma:ConsultationStatus]`, `CallStatus` (`INITIATED`, `ACTIVE`, `ENDED`, `FAILED`) `[schema.prisma:CallStatus]`
- Models: `User` (`users`) `[schema.prisma:User]`, `Pet` (`pets`) `[schema.prisma:Pet]`, `Consultation` (`consultations`) `[schema.prisma:Consultation]`, `ConsultationAuditLog` (`consultation_audit_log`) `[schema.prisma:ConsultationAuditLog]`, `Message` (`messages`) `[schema.prisma:Message]`, `Call` (`calls`) `[schema.prisma:Call]`, `Prescription` (`prescriptions`) `[schema.prisma:Prescription]`, `Review` (`reviews`) `[schema.prisma:Review]`, `AuditLog` (`audit_logs`) `[schema.prisma:AuditLog]`, `DailyUploadCounter` (`daily_upload_counters`) `[schema.prisma:DailyUploadCounter]`, `MediaFile` (`media_files`) `[schema.prisma:MediaFile]`, `PushToken` (`push_tokens`) `[schema.prisma:PushToken]`, `Notification` (`notifications`) `[schema.prisma:Notification]`, `PasswordResetToken` (`password_reset_tokens`) `[schema.prisma:PasswordResetToken]`, `EmailDispatchLog` (`email_dispatch_logs`) `[schema.prisma:EmailDispatchLog]`
- Seed script `prisma` (`PrismaClient`) and `main()` (`seed.ts`) `[seed.ts:prisma]`, `[seed.ts:main]`
- Subdirectory: [migrations](./migrations/README.md)

## Invariants
- Unique constraints on `User.email` `[schema.prisma:User]`, `Message.clientMsgId` `[schema.prisma:Message]`, `Review.consultationId` `[schema.prisma:Review]`, `DailyUploadCounter(userId, date)` `[schema.prisma:DailyUploadCounter]`, `PushToken.token` `[schema.prisma:PushToken]`, and `EmailDispatchLog.dedupeKey` `[schema.prisma:EmailDispatchLog]`.
- `Pet.owner` and `ConsultationAuditLog.consultation` enforce `onDelete: Cascade` `[schema.prisma:Pet]`, `[schema.prisma:ConsultationAuditLog]`.
- `Consultation` defaults `transportStatus` to `"OFFLINE"` and `stateVersion` to `1` `[schema.prisma:Consultation]`.
- `main()` upserts the 5 seed users by `email` (idempotent) but inserts `Rex` and `Mishi` via `prisma.pet.create` (creates duplicate pets if executed repeatedly) `[seed.ts:main]`.

## Side Effects
- `main()` connects via `PrismaClient`, hashes `'Password123!'` with `bcryptjs` (cost 12), upserts 5 records in `users`, inserts 2 records in `pets`, logs to stdout/stderr, calls `process.exit(1)` on error, and calls `prisma.$disconnect()` in `finally` `[seed.ts:main]`.

## Verification
- Run: `npm test -w backend`
