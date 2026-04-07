-- Add current_message to agent_runs for live progress tracking.
-- Stores the most recent status message from the agent during execution.
-- Distinct from summary (which is the final result written on completion).

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS current_message TEXT;
