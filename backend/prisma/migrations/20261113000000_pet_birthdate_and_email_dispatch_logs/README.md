# 20261113000000_pet_birthdate_and_email_dispatch_logs

## Overview
PostgreSQL migration adding `birth_date` to `"pets"` and introducing `"email_dispatch_logs"` for deduplicated email dispatch tracking.

## Interface
- Table alteration on `"pets"` adding nullable column `"birth_date" TIMESTAMP(3)` `[migration.sql:pets]`
- Table `"email_dispatch_logs"` (`id`, `dedupe_key`, `type`, `entity_id`, `recipient_email`, `sent_at`) with PK `email_dispatch_logs_pkey` `[migration.sql:email_dispatch_logs]`
- Unique index `email_dispatch_logs_dedupe_key_key` on `"email_dispatch_logs"("dedupe_key")` `[migration.sql:email_dispatch_logs_dedupe_key_key]`
- Index `email_dispatch_logs_type_entity_id_sent_at_idx` on `"email_dispatch_logs"("type", "entity_id", "sent_at")` `[migration.sql:email_dispatch_logs_type_entity_id_sent_at_idx]`

## Invariants
- Uniqueness enforced on `"email_dispatch_logs"("dedupe_key")` `[migration.sql:email_dispatch_logs_dedupe_key_key]`.
- Column, table, and index statements use `IF NOT EXISTS` guards `[migration.sql:email_dispatch_logs]`.

## Side Effects
- Executes PostgreSQL DDL altering `"pets"` and creating `"email_dispatch_logs"` along with 2 indexes `[migration.sql:pets]`, `[migration.sql:email_dispatch_logs]`.

## Verification
- Run: `npm test -w backend`
