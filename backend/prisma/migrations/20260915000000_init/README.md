# 20260915000000_init

## Overview
Initial PostgreSQL schema migration establishing core enums, relational tables, indexes, and foreign-key constraints for users, pets, consultations, messages, calls, prescriptions, reviews, audit logs, upload counters, media files, push tokens, and notifications.

## Interface
- Enum `Role` (`CLIENT`, `VET`, `ADMIN`) `[migration.sql:Role]`
- Enum `VetStatus` (`PENDING`, `APPROVED`, `REJECTED`) `[migration.sql:VetStatus]`
- Enum `ConsultationStatus` (`WAITING`, `ACTIVE`, `COMPLETED`, `CANCELLED`) `[migration.sql:ConsultationStatus]`
- Enum `CallStatus` (`INITIATED`, `ACTIVE`, `ENDED`) `[migration.sql:CallStatus]`
- Table `"users"` with PK `users_pkey`, unique index `users_email_key`, index `users_role_is_online_vet_status_deleted_at_idx` `[migration.sql:users]`
- Table `"pets"` with PK `pets_pkey`, index `pets_owner_id_deleted_at_idx`, FK `pets_owner_id_fkey` `[migration.sql:pets]`
- Table `"consultations"` with PK `consultations_pkey`, indexes `consultations_client_id_status_deleted_at_idx`, `consultations_vet_id_status_deleted_at_idx`, FKs `consultations_client_id_fkey`, `consultations_vet_id_fkey`, `consultations_pet_id_fkey` `[migration.sql:consultations]`
- Table `"messages"` with PK `messages_pkey`, unique index `messages_client_msg_id_key`, index `messages_consultation_id_created_at_idx`, FKs `messages_consultation_id_fkey`, `messages_sender_id_fkey` `[migration.sql:messages]`
- Table `"calls"` with PK `calls_pkey`, FK `calls_consultation_id_fkey` `[migration.sql:calls]`
- Table `"prescriptions"` with PK `prescriptions_pkey`, FKs `prescriptions_consultation_id_fkey`, `prescriptions_vet_id_fkey` `[migration.sql:prescriptions]`
- Table `"reviews"` with PK `reviews_pkey`, unique index `reviews_consultation_id_key`, FKs `reviews_consultation_id_fkey`, `reviews_client_id_fkey`, `reviews_vet_id_fkey` `[migration.sql:reviews]`
- Table `"audit_logs"` with PK `audit_logs_pkey`, FK `audit_logs_admin_id_fkey` `[migration.sql:audit_logs]`
- Table `"daily_upload_counters"` with PK `daily_upload_counters_pkey`, unique index `daily_upload_counters_user_id_date_key`, FK `daily_upload_counters_user_id_fkey` `[migration.sql:daily_upload_counters]`
- Table `"media_files"` with PK `media_files_pkey`, indexes `media_files_owner_id_deleted_at_idx`, `media_files_consultation_id_deleted_at_idx`, FKs `media_files_owner_id_fkey`, `media_files_consultation_id_fkey` `[migration.sql:media_files]`
- Table `"push_tokens"` with PK `push_tokens_pkey`, unique index `push_tokens_token_key`, index `push_tokens_user_id_idx`, FK `push_tokens_user_id_fkey` `[migration.sql:push_tokens]`
- Table `"notifications"` with PK `notifications_pkey`, index `notifications_user_id_is_read_created_at_idx`, FK `notifications_user_id_fkey` `[migration.sql:notifications]`

## Invariants
- Unique constraints enforced on `"users"("email")` `[migration.sql:users_email_key]`, `"messages"("client_msg_id")` `[migration.sql:messages_client_msg_id_key]`, `"reviews"("consultation_id")` `[migration.sql:reviews_consultation_id_key]`, `"daily_upload_counters"("user_id", "date")` `[migration.sql:daily_upload_counters_user_id_date_key]`, and `"push_tokens"("token")` `[migration.sql:push_tokens_token_key]`.
- `pets_owner_id_fkey` uses `ON DELETE CASCADE ON UPDATE CASCADE` `[migration.sql:pets_owner_id_fkey]`; `consultations_vet_id_fkey` and `media_files_consultation_id_fkey` use `ON DELETE SET NULL ON UPDATE CASCADE` `[migration.sql:consultations_vet_id_fkey]`, `[migration.sql:media_files_consultation_id_fkey]`; all remaining 15 foreign keys use `ON DELETE RESTRICT ON UPDATE CASCADE` `[migration.sql:consultations_client_id_fkey]`.

## Side Effects
- Executes PostgreSQL DDL creating 4 enum types, 12 tables, 14 indexes (5 unique, 9 non-unique), and 18 foreign-key constraints `[migration.sql:users]`.

## Verification
- Run: `npm test -w backend`
