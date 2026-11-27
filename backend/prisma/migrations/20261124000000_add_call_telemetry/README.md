# 20261124000000_add_call_telemetry

## Overview
PostgreSQL migration extending `"CallStatus"` with `'FAILED'` and adding LiveKit/telemetry columns and descending lookup indexes to `"calls"`.

## Interface
- Enum `"CallStatus"` value `'FAILED'` added via `ALTER TYPE "CallStatus" ADD VALUE IF NOT EXISTS 'FAILED'` `[migration.sql:CallStatus]`
- Table alteration on `"calls"` adding columns `livekit_room_sid`, `participant_count`, `error_code`, `error_message`, `disconnect_reason`, `last_event`, and `metadata` `[migration.sql:calls]`
- Index `calls_consultation_id_created_at_idx` on `"calls"("consultation_id", "created_at" DESC)` `[migration.sql:calls_consultation_id_created_at_idx]`
- Index `calls_room_name_created_at_idx` on `"calls"("room_name", "created_at" DESC)` `[migration.sql:calls_room_name_created_at_idx]`

## Invariants
- `"calls"."participant_count"` is `INTEGER NOT NULL DEFAULT 0` `[migration.sql:calls]`.
- Enum value, column additions, and indexes use `IF NOT EXISTS` guards `[migration.sql:CallStatus]`, `[migration.sql:calls]`.

## Side Effects
- Executes PostgreSQL DDL modifying enum `"CallStatus"`, adding 7 telemetry columns to `"calls"`, and creating 2 descending indexes `[migration.sql:CallStatus]`, `[migration.sql:calls]`.

## Verification
- Run: `npm test -w backend`
