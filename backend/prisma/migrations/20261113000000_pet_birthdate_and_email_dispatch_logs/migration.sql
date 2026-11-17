-- AlterTable
ALTER TABLE "pets" ADD COLUMN IF NOT EXISTS "birth_date" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_dispatch_logs" (
    "id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entity_id" TEXT,
    "recipient_email" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_dispatch_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_dispatch_logs_dedupe_key_key" ON "email_dispatch_logs"("dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_dispatch_logs_type_entity_id_sent_at_idx" ON "email_dispatch_logs"("type", "entity_id", "sent_at");
