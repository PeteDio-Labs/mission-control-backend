-- Migration 003: Add task queue columns to agent_runs
--
-- Adds queue management columns and expands the status CHECK constraint
-- to include 'queued' and 'dead-letter'. Also changes the status DEFAULT
-- from 'running' to 'queued' so new rows are picked up by the TaskQueue
-- poll loop rather than being left in a terminal 'running' state forever.
--
-- IMPORTANT: Deploy this migration simultaneously with the agentStore.ts
-- change that sets status='queued' on insertRun. If deployed ahead of
-- the code change, existing rows will still insert as 'running' (the
-- agentStore upsert preserves existing behaviour for conflict cases).

-- 1. Drop the old status CHECK constraint
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;

-- 2. Add new constraint that includes queue states
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('queued', 'running', 'waiting_approval', 'complete', 'failed', 'dead-letter'));

-- 3. Change default from 'running' to 'queued'
ALTER TABLE agent_runs ALTER COLUMN status SET DEFAULT 'queued';

-- 4. Add queue management columns
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS retry_count   INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries   INT          NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by     TEXT,
  ADD COLUMN IF NOT EXISTS locked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priority      INT          NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS timeout_at    TIMESTAMPTZ;

-- 5. Index for efficient queue polling
CREATE INDEX IF NOT EXISTS idx_agent_runs_queue
  ON agent_runs (status, priority ASC, created_at ASC)
  WHERE status = 'queued';
