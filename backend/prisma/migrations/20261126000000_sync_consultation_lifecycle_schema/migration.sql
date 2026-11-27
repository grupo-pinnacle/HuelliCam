-- Sync migration: brings the migration history in line with prisma/schema.prisma.
--
-- Background: consultations lifecycle columns, consultation_audit_log and
-- password_reset_tokens existed in schema.prisma (and in databases provisioned with
-- `prisma db push`) but were never captured by a migration, so `prisma migrate deploy`
-- on a fresh database produced a schema that the current code cannot run against.
--
-- This migration is fully idempotent:
--   * Fresh database (migrate deploy): creates everything that is missing.
--   * Database provisioned with `db push`: every statement is a no-op, except the enum
--     cleanup below, which only runs when deprecated ConsultationStatus labels still exist.
--
-- Enum cleanup: when deprecated labels are present, legacy rows are first normalized
-- (vet_id IS NULL -> WAITING, otherwise ACTIVE, one LEGACY_STATUS_BACKFILL audit row each)
-- and the enum is then recreated with the 4 canonical states.

-- Consultation lifecycle columns
ALTER TABLE "consultations" ADD COLUMN IF NOT EXISTS "active_device_id" TEXT;
ALTER TABLE "consultations" ADD COLUMN IF NOT EXISTS "transport_status" TEXT NOT NULL DEFAULT 'OFFLINE';
ALTER TABLE "consultations" ADD COLUMN IF NOT EXISTS "state_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "consultations" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);
ALTER TABLE "consultations" ADD COLUMN IF NOT EXISTS "livekit_room_sid" TEXT;

-- Consultation audit log
CREATE TABLE IF NOT EXISTS "consultation_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "consultation_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "previous_state" TEXT,
    "new_state" TEXT,
    "actor_id" TEXT,
    "device_id" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "consultation_audit_log_consultation_id_created_at_idx"
    ON "consultation_audit_log"("consultation_id", "created_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'consultation_audit_log_consultation_id_fkey'
  ) THEN
    ALTER TABLE "consultation_audit_log"
      ADD CONSTRAINT "consultation_audit_log_consultation_id_fkey"
      FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- Password reset tokens
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "password_reset_tokens_email_expires_at_idx"
    ON "password_reset_tokens"("email", "expires_at");

-- ConsultationStatus enum cleanup (runs only if deprecated labels still exist)
DO $$
DECLARE
  has_deprecated BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ConsultationStatus'
      AND e.enumlabel NOT IN ('WAITING', 'ACTIVE', 'COMPLETED', 'CANCELLED')
  ) INTO has_deprecated;

  IF NOT has_deprecated THEN
    RETURN;
  END IF;

  WITH legacy_rows AS (
    SELECT id, status::text AS previous_state, vet_id, started_at, updated_at
    FROM consultations
    WHERE status::text NOT IN ('WAITING', 'ACTIVE', 'COMPLETED', 'CANCELLED')
  ),
  updated_rows AS (
    UPDATE consultations c
    SET
      status = CASE WHEN l.vet_id IS NULL THEN 'WAITING'::"ConsultationStatus" ELSE 'ACTIVE'::"ConsultationStatus" END,
      started_at = CASE WHEN l.vet_id IS NULL THEN NULL ELSE COALESCE(l.started_at, l.updated_at, NOW()) END,
      state_version = c.state_version + 1,
      updated_at = NOW()
    FROM legacy_rows l
    WHERE c.id = l.id
    RETURNING c.id AS consultation_id, l.previous_state, c.status::text AS new_state, c.active_device_id
  )
  INSERT INTO consultation_audit_log (consultation_id, event_type, previous_state, new_state, device_id, metadata, created_at)
  SELECT
    consultation_id,
    'LEGACY_STATUS_BACKFILL',
    previous_state,
    new_state,
    active_device_id,
    jsonb_build_object('reason', 'sync_consultation_lifecycle_schema', 'previousState', previous_state, 'newState', new_state),
    NOW()
  FROM updated_rows;

  ALTER TABLE "consultations" ALTER COLUMN "status" DROP DEFAULT;
  ALTER TYPE "ConsultationStatus" RENAME TO "ConsultationStatus_old";
  CREATE TYPE "ConsultationStatus" AS ENUM ('WAITING', 'ACTIVE', 'COMPLETED', 'CANCELLED');
  ALTER TABLE "consultations"
    ALTER COLUMN "status" TYPE "ConsultationStatus" USING "status"::text::"ConsultationStatus";
  ALTER TABLE "consultations" ALTER COLUMN "status" SET DEFAULT 'WAITING';
  DROP TYPE "ConsultationStatus_old";
END
$$;
