-- RETRO.27 — partial unique index on (source, source_metadata->>'fingerprint')
-- scoped to alertmanager kind=alert with an active status.
--
-- The JS-side dedupe in alertmanager.ts:findOpenPlanByFingerprint is TOCTOU:
-- it does listPlans + JS filter, then createPlan. Two concurrent webhook
-- calls for the same fingerprint race between the check and the insert,
-- producing duplicate plans. This index makes the DB the source of truth.
--
-- We can't use CREATE INDEX CONCURRENTLY because the migration runner
-- wraps each migration in a transaction. Plain CREATE UNIQUE INDEX is
-- acceptable at our scale (low-write plans table; brief AccessExclusiveLock).
--
-- The handler code in alertmanager.ts is being updated in the same change
-- to catch 23505 unique_violation and treat as "already have one, skip".

CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_alertmanager_fingerprint_open
  ON plans (source, (source_metadata->>'fingerprint'))
  WHERE source = 'alertmanager'
    AND kind = 'alert'
    AND status IN ('pending','presented','clicked','dispatched','in_progress','stuck');

COMMENT ON INDEX idx_plans_alertmanager_fingerprint_open IS
  'RETRO.27 — prevents duplicate plans for the same active Alertmanager alert (by fingerprint). Backed by error-code 23505 handling in alertmanager.ts.';
