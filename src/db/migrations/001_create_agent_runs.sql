-- Agent Runs — stores every agent task dispatch + lifecycle
-- Supports: MC Backend agent endpoints (trigger, status, result, approve/reject)

CREATE TABLE IF NOT EXISTS agent_runs (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id         TEXT        UNIQUE NOT NULL,
  agent_name      TEXT        NOT NULL,
  trigger         TEXT        NOT NULL CHECK (trigger IN ('infra-event', 'cron', 'manual', 'github')),
  status          TEXT        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running', 'waiting_approval', 'complete', 'failed')),
  input           JSONB       NOT NULL DEFAULT '{}',
  result          JSONB,
  pending_approval JSONB,
  summary         TEXT,
  issued_at       TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_runs_agent_name  ON agent_runs(agent_name);
CREATE INDEX idx_agent_runs_status      ON agent_runs(status);
CREATE INDEX idx_agent_runs_created_at  ON agent_runs(created_at DESC);
CREATE INDEX idx_agent_runs_task_id     ON agent_runs(task_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_runs_updated_at
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
