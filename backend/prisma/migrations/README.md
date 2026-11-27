# migrations

## Overview
Ordered PostgreSQL migration history for the backend Prisma schema (`provider = "postgresql"` in `migration_lock.toml`).

## Subdirectories & Boundaries
- 20260915000000_init: [20260915000000_init](./20260915000000_init/README.md) - Initial schema DDL defining 4 enums, 12 tables, 14 indexes, and 18 foreign-key constraints.
- 20261113000000_pet_birthdate_and_email_dispatch_logs: [20261113000000_pet_birthdate_and_email_dispatch_logs](./20261113000000_pet_birthdate_and_email_dispatch_logs/README.md) - Adds `pets.birth_date` and creates `email_dispatch_logs` for deduplicated email logs.
- 20261124000000_add_call_telemetry: [20261124000000_add_call_telemetry](./20261124000000_add_call_telemetry/README.md) - Extends `CallStatus` with `FAILED` and adds LiveKit/telemetry columns and descending indexes to `calls`.
- 20261126000000_sync_consultation_lifecycle_schema: Idempotent catch-up migration (no separate README). Adds the 5 lifecycle columns on `consultations` (`active_device_id`, `transport_status`, `state_version`, `claimed_at`, `livekit_room_sid`), `consultation_audit_log` and `password_reset_tokens` that existed in `schema.prisma` but in no earlier migration. If a database still carries the 6 deprecated `ConsultationStatus` labels (e.g. provisioned with `prisma db push`), it normalizes those rows to `WAITING`/`ACTIVE` (one `LEGACY_STATUS_BACKFILL` audit row each) and recreates the enum with the 4 canonical states; otherwise the enum step is a no-op.
