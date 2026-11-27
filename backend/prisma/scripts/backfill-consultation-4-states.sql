-- Idempotent pre-deploy backfill for Huellicam 4-state consultation standardization.
-- Normalizes any row left in the 6 deprecated extended enum states into the canonical
-- 4-state runtime contract ('WAITING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED')
-- without executing a destructive ALTER TYPE on PostgreSQL ConsultationStatus.

BEGIN;

WITH legacy_rows AS (
  SELECT
    id,
    status::text AS previous_state,
    vet_id,
    active_device_id,
    started_at,
    updated_at
  FROM consultations
  WHERE status::text IN (
    'TRIAGE_CRITICAL_QUEUED',
    'CLAIM_PENDING_SYNC',
    'LIVEKIT_CONNECTING',
    'IN_CALL_ACTIVE',
    'AWAITING_EMERGENCY_CALLBACK',
    'HANDOFF_IN_PROGRESS'
  )
),
updated_rows AS (
  UPDATE consultations c
  SET
    status = CASE
      WHEN l.vet_id IS NULL THEN 'WAITING'::"ConsultationStatus"
      ELSE 'ACTIVE'::"ConsultationStatus"
    END,
    started_at = CASE
      WHEN l.vet_id IS NULL THEN NULL
      ELSE COALESCE(l.started_at, l.updated_at, NOW())
    END,
    state_version = c.state_version + 1,
    updated_at = NOW()
  FROM legacy_rows l
  WHERE c.id = l.id
  RETURNING
    c.id AS consultation_id,
    l.previous_state,
    c.status::text AS new_state,
    c.active_device_id
)
INSERT INTO consultation_audit_log (
  consultation_id,
  event_type,
  previous_state,
  new_state,
  device_id,
  metadata,
  created_at
)
SELECT
  consultation_id,
  'LEGACY_STATUS_BACKFILL',
  previous_state,
  new_state,
  active_device_id,
  jsonb_build_object(
    'reason', 'backfill-consultation-4-states',
    'previousState', previous_state,
    'newState', new_state
  ),
  NOW()
FROM updated_rows;

COMMIT;

-- Post-backfill verification (must return 0):
SELECT COUNT(*) AS remaining_deprecated
FROM consultations
WHERE status::text NOT IN ('WAITING', 'ACTIVE', 'COMPLETED', 'CANCELLED');
