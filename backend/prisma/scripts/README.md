# scripts

## Overview
Holds manual, idempotent SQL maintenance scripts that run outside Prisma migrations.

## Interface
- `[backfill-consultation-4-states.sql]` - Optional manual backfill, superseded by migration `20261126000000_sync_consultation_lifecycle_schema`, which performs the same normalization automatically during `prisma migrate deploy` and then removes the deprecated enum labels. Keep it only as a standalone pre-check: it rewrites consultations left in the 6 deprecated `ConsultationStatus` literals to `WAITING` (no `vet_id`, clears `started_at`) or `ACTIVE` (with `vet_id`, keeps or sets `started_at`), bumps `state_version`, and writes one `LEGACY_STATUS_BACKFILL` row per change to `consultation_audit_log`. Ends with a verification query that must return `remaining_deprecated = 0`. It is a no-op once the migration has run, because no row can hold a deprecated literal.

## Global Invariants
- The script never alters the PostgreSQL `ConsultationStatus` enum type; the enum is recreated only by the migration.
- Running it twice is safe: the second run matches no rows.

## Global Side Effects
- Executes inside a single `BEGIN`/`COMMIT` transaction and updates `consultations` and inserts into `consultation_audit_log`.
