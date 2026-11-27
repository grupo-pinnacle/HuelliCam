-- Roadmap Phases 1 to 6 Schema Migration (idempotent & zero breaking scalar edits on core tables)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VaccineStatus') THEN
    CREATE TYPE "VaccineStatus" AS ENUM ('UP_TO_DATE', 'UPCOMING', 'OVERDUE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PetDocumentCategory') THEN
    CREATE TYPE "PetDocumentCategory" AS ENUM ('LAB_RESULT', 'IMAGING', 'CERTIFICATE', 'PRESCRIPTION', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FollowUpStatus') THEN
    CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ClinicalTemplateKind') THEN
    CREATE TYPE "ClinicalTemplateKind" AS ENUM ('EVOLUTION', 'PRESCRIPTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerEntryStatus') THEN
    CREATE TYPE "LedgerEntryStatus" AS ENUM ('SIMULATED', 'PENDING_SETTLEMENT', 'SETTLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_verification_tokens_user_id_key" ON "email_verification_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_email_expires_at_idx" ON "email_verification_tokens"("email", "expires_at");

CREATE TABLE IF NOT EXISTS "pet_profile_media" (
  "pet_id" TEXT NOT NULL,
  "media_file_id" TEXT,
  "photo_url" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pet_profile_media_pkey" PRIMARY KEY ("pet_id"),
  CONSTRAINT "pet_profile_media_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pet_profile_media_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "media_pet_links" (
  "media_file_id" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_pet_links_pkey" PRIMARY KEY ("media_file_id"),
  CONSTRAINT "media_pet_links_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "media_pet_links_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "media_pet_links_pet_id_idx" ON "media_pet_links"("pet_id");

CREATE TABLE IF NOT EXISTS "consultation_metadata" (
  "consultation_id" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3),
  "rescheduled_from_id" TEXT,
  "incident_code" TEXT,
  "fee_snapshot" INTEGER,
  "take_rate_snapshot" DOUBLE PRECISION,
  "currency_snapshot" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "consultation_metadata_pkey" PRIMARY KEY ("consultation_id"),
  CONSTRAINT "consultation_metadata_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "consultation_metadata_scheduled_at_idx" ON "consultation_metadata"("scheduled_at");

CREATE TABLE IF NOT EXISTS "pet_vaccines" (
  "id" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "applied_at" TIMESTAMP(3) NOT NULL,
  "next_due_at" TIMESTAMP(3),
  "status" "VaccineStatus" NOT NULL DEFAULT 'UP_TO_DATE',
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "pet_vaccines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pet_vaccines_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pet_vaccines_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "pet_vaccines_pet_id_deleted_at_idx" ON "pet_vaccines"("pet_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "pet_vaccines_next_due_at_deleted_at_idx" ON "pet_vaccines"("next_due_at", "deleted_at");

CREATE TABLE IF NOT EXISTS "pet_documents" (
  "id" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "consultation_id" TEXT,
  "media_file_id" TEXT,
  "uploaded_by_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "category" "PetDocumentCategory" NOT NULL DEFAULT 'OTHER',
  "external_url" TEXT,
  "size_label" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "pet_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pet_documents_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pet_documents_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pet_documents_media_file_id_fkey" FOREIGN KEY ("media_file_id") REFERENCES "media_files"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pet_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "pet_documents_pet_id_deleted_at_idx" ON "pet_documents"("pet_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "pet_documents_media_file_id_idx" ON "pet_documents"("media_file_id");

CREATE TABLE IF NOT EXISTS "clinical_evolutions" (
  "id" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "consultation_id" TEXT,
  "vet_id" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "subjective" TEXT,
  "objective" TEXT,
  "assessment" TEXT,
  "plan" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "clinical_evolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clinical_evolutions_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "clinical_evolutions_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "clinical_evolutions_vet_id_fkey" FOREIGN KEY ("vet_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "clinical_evolutions_pet_id_created_at_idx" ON "clinical_evolutions"("pet_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "clinical_evolutions_consultation_id_idx" ON "clinical_evolutions"("consultation_id");

CREATE TABLE IF NOT EXISTS "pet_co_owners" (
  "id" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "invited_by_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'CO_TUTOR',
  "accepted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pet_co_owners_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pet_co_owners_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pet_co_owners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pet_co_owners_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "pet_co_owners_pet_id_user_id_key" ON "pet_co_owners"("pet_id", "user_id");
CREATE INDEX IF NOT EXISTS "pet_co_owners_user_id_idx" ON "pet_co_owners"("user_id");

CREATE TABLE IF NOT EXISTS "vet_availability_slots" (
  "id" TEXT NOT NULL,
  "vet_id" TEXT NOT NULL,
  "day_of_week" INTEGER NOT NULL,
  "start_time" TEXT NOT NULL,
  "end_time" TEXT NOT NULL,
  "slot_duration_min" INTEGER NOT NULL DEFAULT 30,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vet_availability_slots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vet_availability_slots_vet_id_fkey" FOREIGN KEY ("vet_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "vet_availability_slots_vet_id_day_of_week_is_active_idx"
  ON "vet_availability_slots"("vet_id", "day_of_week", "is_active");

CREATE TABLE IF NOT EXISTS "follow_ups" (
  "id" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "consultation_id" TEXT,
  "vet_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "due_at" TIMESTAMP(3) NOT NULL,
  "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
  "reminder_sent_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "follow_ups_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "follow_ups_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "follow_ups_vet_id_fkey" FOREIGN KEY ("vet_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "follow_ups_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "follow_ups_vet_id_status_due_at_idx" ON "follow_ups"("vet_id", "status", "due_at");
CREATE INDEX IF NOT EXISTS "follow_ups_client_id_status_due_at_idx" ON "follow_ups"("client_id", "status", "due_at");

CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "web_push_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "web_push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "web_push_subscriptions_endpoint_key" ON "web_push_subscriptions"("endpoint");
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_user_id_idx" ON "web_push_subscriptions"("user_id");

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "user_id" TEXT NOT NULL,
  "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
  "push_enabled" BOOLEAN NOT NULL DEFAULT true,
  "email_reminders_enabled" BOOLEAN NOT NULL DEFAULT true,
  "vaccine_reminders" BOOLEAN NOT NULL DEFAULT true,
  "appointment_reminders" BOOLEAN NOT NULL DEFAULT true,
  "marketing_enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "clinical_templates" (
  "id" TEXT NOT NULL,
  "vet_id" TEXT,
  "kind" "ClinicalTemplateKind" NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'General',
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clinical_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clinical_templates_vet_id_fkey" FOREIGN KEY ("vet_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "clinical_templates_vet_id_kind_idx" ON "clinical_templates"("vet_id", "kind");

CREATE TABLE IF NOT EXISTS "telemedicine_consents" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip_address" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "telemedicine_consents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telemedicine_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "telemedicine_consents_user_id_version_idx" ON "telemedicine_consents"("user_id", "version");

CREATE TABLE IF NOT EXISTS "platform_feature_flags" (
  "key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "description" TEXT NOT NULL,
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_feature_flags_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "platform_pricing_settings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "base_consultation_fee" INTEGER NOT NULL DEFAULT 15000,
  "platform_take_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
  "currency" TEXT NOT NULL DEFAULT 'ARS',
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_pricing_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "vet_ledger_entries" (
  "id" TEXT NOT NULL,
  "consultation_id" TEXT NOT NULL,
  "vet_id" TEXT NOT NULL,
  "gross_amount" INTEGER NOT NULL,
  "platform_fee" INTEGER NOT NULL,
  "vet_net_amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'ARS',
  "status" "LedgerEntryStatus" NOT NULL DEFAULT 'SIMULATED',
  "external_provider" TEXT,
  "external_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vet_ledger_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vet_ledger_entries_consultation_id_fkey" FOREIGN KEY ("consultation_id") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vet_ledger_entries_vet_id_fkey" FOREIGN KEY ("vet_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "vet_ledger_entries_consultation_id_key" ON "vet_ledger_entries"("consultation_id");
CREATE INDEX IF NOT EXISTS "vet_ledger_entries_vet_id_status_created_at_idx" ON "vet_ledger_entries"("vet_id", "status", "created_at" DESC);
