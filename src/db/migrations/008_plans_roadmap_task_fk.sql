-- Migration 008: Link Plans to Roadmap Tasks
--
-- Adds a nullable FK from plans.roadmap_task_id to roadmap_tasks(id) so a
-- Runtime Plan can be associated with the long-lived Master Plan item it
-- belongs to (e.g. an alertmanager-triggered Plan against PB.10's qbit-vpn
-- watchdog).
--
-- Reference design: planning/MIGRATE-KANBAN-TO-MC.md (Phase 3).
--
-- Design notes:
--   • NULLABLE — Runtime Plans frequently exist without a roadmap link
--     (alertmanager pages, ad-hoc proposals, manual user-created plans).
--   • ON DELETE SET NULL — if the roadmap task is removed, keep the plan
--     history intact (just orphan it). CASCADE would lose audit trail.
--   • Partial index — most plans will have roadmap_task_id IS NULL; only
--     index the linked rows so the back-reference query
--     `SELECT plans WHERE roadmap_task_id = $1` is fast without bloating
--     the index with NULL entries.
--
-- DO NOT add BEGIN/COMMIT — the migration runner wraps each file in a
-- transaction via db.transaction().

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS roadmap_task_id TEXT NULL
    REFERENCES roadmap_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_plans_roadmap_task_id
  ON plans (roadmap_task_id)
  WHERE roadmap_task_id IS NOT NULL;
