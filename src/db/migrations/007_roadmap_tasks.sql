-- Migration 007: Roadmap Tasks — MC-managed kanban
--
-- Brings the static master-plan kanban (planning/master-plan-kanban-tasks.ts)
-- into MC Backend as a first-class resource. Sibling to the Plans table from
-- migration 005; the two relate via plans.roadmap_task_id (added in 008).
--
-- Reference design: planning/MIGRATE-KANBAN-TO-MC.md (Phase 1).
--
-- Tables created:
--   • roadmap_tasks         — long-lived units of work on the Master Plan
--                              (PB.10, RETRO.13, 1.7, etc.). IDs are the kanban
--                              IDs verbatim — TEXT, caller-supplied.
--   • roadmap_task_events   — append-only audit log per task (status changes,
--                              comments, plan_linked events emitted by 008).
--
-- Design notes:
--   • roadmap_tasks.id is TEXT (matches the kanban IDs like "PB.10" / "RETRO.13"
--     / "0.1") — caller-supplied at create time. The importer upserts on this PK.
--   • roadmap_tasks.ws is a free-form TEXT — the enum + display names live in
--     MC Web (planning/master-plan-kanban-types.ts WS_NAMES). No FK; adding new
--     workstreams is a frontend-only change.
--   • status check matches the kanban's exact enum:
--     backlog | in-progress | blocked | awaiting-user | done. Hyphenated to
--     keep parity with the kanban; matches what the TS file already uses.
--   • No state-machine validation — roadmap statuses are free-flowing (any
--     transition allowed). Every updateStatus writes a status_change event row
--     for audit (cheap append-only insert in the same transaction).
--   • depends_on is TEXT[] (Postgres array of task IDs) so the kanban's
--     dependsOn arrays survive the import without flattening.
--
-- DO NOT add BEGIN/COMMIT — the migration runner wraps each file in a
-- transaction via db.transaction() (see src/db/migrate.ts).

-- ========================================================================
-- roadmap_tasks
-- ========================================================================

CREATE TABLE IF NOT EXISTS roadmap_tasks (
  id           TEXT        PRIMARY KEY,                         -- "1.1", "PB.10", "RETRO.13"
  ws           TEXT        NOT NULL,                            -- workstream key; enum lives in MC Web
  status       TEXT        NOT NULL DEFAULT 'backlog' CHECK (status IN (
                             'backlog',
                             'in-progress',
                             'blocked',
                             'awaiting-user',
                             'done'
                           )),
  effort       TEXT        NOT NULL DEFAULT '',                 -- '30m', '4h', '2d' — free-form
  title        TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  depends_on   TEXT[]      NOT NULL DEFAULT '{}',               -- array of roadmap_tasks.id values
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "show me workstream X in status Y" — the board view's primary query
CREATE INDEX IF NOT EXISTS idx_roadmap_tasks_ws_status
  ON roadmap_tasks (ws, status);

-- Recency-first listing for the activity / dashboard view
CREATE INDEX IF NOT EXISTS idx_roadmap_tasks_updated_at
  ON roadmap_tasks (updated_at DESC);

CREATE TRIGGER roadmap_tasks_updated_at
  BEFORE UPDATE ON roadmap_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ========================================================================
-- roadmap_task_events
-- ========================================================================
-- Append-only audit log. One row per status change, comment, or
-- plan_linked event (the last is emitted by migration 008 when a Plan is
-- created with roadmap_task_id pointing at this task).

CREATE TABLE IF NOT EXISTS roadmap_task_events (
  id           BIGSERIAL   PRIMARY KEY,
  task_id      TEXT        NOT NULL REFERENCES roadmap_tasks(id) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL CHECK (event_type IN (
                             'created',
                             'status_change',
                             'comment',
                             'updated',
                             'plan_linked'
                           )),
  from_status  TEXT,                                            -- populated for status_change
  to_status    TEXT,                                            -- populated for status_change
  actor        TEXT,                                            -- user email / 'system' / agent name
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Timeline render: all events for a task, oldest first
CREATE INDEX IF NOT EXISTS idx_roadmap_task_events_task_id
  ON roadmap_task_events (task_id, created_at DESC);
