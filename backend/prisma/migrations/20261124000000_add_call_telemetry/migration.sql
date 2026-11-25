-- AlterEnum
ALTER TYPE "CallStatus" ADD VALUE IF NOT EXISTS 'FAILED';

-- AlterTable
ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "livekit_room_sid" TEXT,
  ADD COLUMN IF NOT EXISTS "participant_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "error_code" TEXT,
  ADD COLUMN IF NOT EXISTS "error_message" TEXT,
  ADD COLUMN IF NOT EXISTS "disconnect_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "last_event" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calls_consultation_id_created_at_idx" ON "calls"("consultation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "calls_room_name_created_at_idx" ON "calls"("room_name", "created_at" DESC);
