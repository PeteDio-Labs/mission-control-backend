-- Migration 005: Pete Bot v2 — Plan service backing tables
--
-- Adds the five tables that back the Pete Bot v2 actionable-notification
-- design (kanban workstream PB, task PB.1). Reference design:
--   .claude/plans/look-into-turning-lxc-twinkly-tiger.md
--
-- Tables created:
--   • plans                  — actionable items surfaced to Discord/MC Web
--   • plan_actions           — the buttons a plan offers (first-click-wins
--                              idempotency tracked here)
--   • plan_events            — append-only state-transition log (timeline)
--   • discord_identities     — Discord user ID ↔ MC user mapping
--   • notification_settings  — JSONB key-value config (routing, policy, authz)
--
-- Design notes:
--   • plans.id is TEXT (e.g. 'pl_a3f9c1') — created by MC's Plan service,
--     matches the existing TaskQueue ID style. No FK from anywhere should
--     use UUID for plan_id.
--   • plans.triggered_agent_run_id → agent_runs.id (UUID) — set when the
--     user approves and MC dispatches the proposed fix. NULL means no agent
--     was ever spawned (dismissed / expired / unresolved).
--   • plan_actions are stored as rows (not a JSONB column on plans) so
--     per-action idempotency can be tracked atomically — first click on
--     action_id wins, second click is rejected by the Plan service.
--   • plan_events is append-only; the Plan service emits one row per
--     state transition, click, agent progress, or comment. Read for
--     timeline rendering in MC Web /plans/:id and Pete Bot edit-message.
--   • discord_identities is seeded MANUALLY for pedro in PB v2; PB v3
--     adds self-serve linking via Authentik Discord OAuth (linked_via
--     flag distinguishes the two).
--   • notification_settings is a generic JSONB key-value store; PB.5
--     reads routing/policy from here; PB.12 surfaces in MC Settings UI.
--     Defaults seeded at the bottom of this migration.
--
-- DO NOT add BEGIN/COMMIT — the migration runner wraps each file in a
-- transaction via db.transaction() (see src/db/migrate.ts:98).

-- ========================================================================
-- plans
-- ========================================================================

CREATE TABLE IF NOT EXISTS plans (
  id                      TEXT        PRIMARY KEY,
  kind                    TEXT        NOT NULL CHECK (kind IN (
                                        'proposed_fix',
                                        'alert',
                                        'gated_action',
                                        'eval_regression',
                                        'capacity_warning'
                                      )),
  status                  TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
                                        'pending',
                                        'presented',
                                        'clicked',
                                        'dispatched',
                                        'in_progress',
                                        'succeeded',
                                        'failed',
                                        'stuck',
                                        'resolved',
                                        'dismissed',
                                        'expired'
                                      )),
  severity                TEXT        NOT NULL DEFAULT 'info' CHECK (severity IN (
                                        'info', 'warn', 'error', 'critical'
                                      )),
  source                  TEXT        NOT NULL CHECK (source IN (
                                        'agent', 'alertmanager', 'user', 'cron', 'external'
                                      )),
  source_metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  target                  TEXT,                                  -- e.g. 'qbit-vpn', 'pve01', or NULL
  summary                 TEXT        NOT NULL,
  proposed_fix            JSONB,                                 -- { agent, task } from proposeAction()
  triggered_agent_run_id  UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
  approved_by_mc_user_id  TEXT,                                  -- who clicked (Discord or Web or API)
  approved_via            TEXT        CHECK (approved_via IN ('discord', 'mc_web', 'mc_desktop', 'api')),
  result                  JSONB,                                 -- on succeeded: arbitrary payload
  error_summary           TEXT,                                  -- on failed/stuck
  proposals               JSONB,                                 -- on stuck: [{label,task,mc_url}, ...]
  expires_at              TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,                           -- set on succeeded/failed/resolved/dismissed/expired
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "show me all open plans" — partial index on the active states
CREATE INDEX IF NOT EXISTS idx_plans_active
  ON plans (status, created_at DESC)
  WHERE status IN ('pending', 'presented', 'clicked', 'dispatched', 'in_progress', 'stuck');

CREATE INDEX IF NOT EXISTS idx_plans_kind
  ON plans (kind);

CREATE INDEX IF NOT EXISTS idx_plans_created_at
  ON plans (created_at DESC);

-- Expiry sweep (PB.8): "find plans presented past their expires_at"
CREATE INDEX IF NOT EXISTS idx_plans_expires_at
  ON plans (expires_at)
  WHERE status = 'presented' AND expires_at IS NOT NULL;

-- Idempotency / cross-reference: jump from agent run back to plan
CREATE INDEX IF NOT EXISTS idx_plans_triggered_agent_run_id
  ON plans (triggered_agent_run_id)
  WHERE triggered_agent_run_id IS NOT NULL;

CREATE TRIGGER plans_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ========================================================================
-- plan_actions
-- ========================================================================
-- Composite PK (plan_id, action_id) gives us atomic first-click-wins
-- idempotency via UPDATE ... WHERE acted_at IS NULL.

CREATE TABLE IF NOT EXISTS plan_actions (
  plan_id        TEXT        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  action_id      TEXT        NOT NULL,                           -- e.g. 'yes', 'dismiss', 'snooze_1h'
  label          TEXT        NOT NULL,                           -- display label for the button
  style          TEXT        NOT NULL DEFAULT 'secondary' CHECK (style IN (
                               'primary', 'secondary', 'danger', 'link'
                             )),
  ordering       INT         NOT NULL DEFAULT 0,                 -- display order within the plan
  click_payload  JSONB       NOT NULL DEFAULT '{}'::jsonb,       -- handler-specific data (task, snooze duration, ...)
  acted_at       TIMESTAMPTZ,                                    -- NULL = never clicked; populated on first click
  acted_by_user  TEXT,                                           -- mc_user_id that acted
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plan_id, action_id)
);

CREATE INDEX IF NOT EXISTS idx_plan_actions_plan_ordering
  ON plan_actions (plan_id, ordering);


-- ========================================================================
-- plan_events
-- ========================================================================
-- Append-only state-transition + activity log. No updates, only inserts.
-- BIGSERIAL because plans are high-volume over time (alerts especially).

CREATE TABLE IF NOT EXISTS plan_events (
  id              BIGSERIAL   PRIMARY KEY,
  plan_id         TEXT        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  event_type      TEXT        NOT NULL CHECK (event_type IN (
                                'created',
                                'presented',
                                'clicked',
                                'dispatched',
                                'state_change',
                                'agent_progress',
                                'succeeded',
                                'failed',
                                'stuck',
                                'dismissed',
                                'expired',
                                'resolved',
                                'comment',
                                'duplicate_click'
                              )),
  action_id       TEXT,                                          -- NOT a FK — keep events even if action rows are purged
  actor_user_id   TEXT,                                          -- mc_user_id; NULL for system events
  actor_source    TEXT        CHECK (actor_source IN (
                                'discord', 'mc_web', 'mc_desktop', 'api', 'system', 'agent'
                              )),
  from_status     TEXT,                                          -- populated for state_change events
  to_status       TEXT,                                          -- populated for state_change events
  detail          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Timeline render (PB.11 /plans/:id): all events for a plan, oldest first
CREATE INDEX IF NOT EXISTS idx_plan_events_plan_id_occurred
  ON plan_events (plan_id, occurred_at);

-- Recent activity feed across all plans
CREATE INDEX IF NOT EXISTS idx_plan_events_occurred
  ON plan_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_plan_events_event_type
  ON plan_events (event_type);


-- ========================================================================
-- discord_identities
-- ========================================================================

CREATE TABLE IF NOT EXISTS discord_identities (
  discord_user_id  TEXT         PRIMARY KEY,
  mc_user_id       TEXT         NOT NULL,                        -- MC/Authentik user identifier
  display_name     TEXT,                                          -- cosmetic, e.g. 'pedro'
  linked_via       TEXT         NOT NULL CHECK (linked_via IN ('manual', 'authentik_oauth')),
  linked_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ,
  revoked          BOOLEAN      NOT NULL DEFAULT FALSE,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Reverse lookup: "what Discord IDs does this MC user have linked?"
CREATE INDEX IF NOT EXISTS idx_discord_identities_mc_user_id
  ON discord_identities (mc_user_id)
  WHERE revoked = FALSE;

CREATE TRIGGER discord_identities_updated_at
  BEFORE UPDATE ON discord_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ========================================================================
-- notification_settings
-- ========================================================================

CREATE TABLE IF NOT EXISTS notification_settings (
  setting_key    TEXT         PRIMARY KEY,
  setting_value  JSONB        NOT NULL,
  description    TEXT,                                            -- human-readable purpose; surfaced in MC Settings UI
  updated_by     TEXT,                                            -- mc_user_id of last writer
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER notification_settings_updated_at
  BEFORE UPDATE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed defaults. PB.5 router reads these; PB.12 Settings UI edits them.
-- ON CONFLICT DO NOTHING so re-running on an already-seeded DB is a no-op.
INSERT INTO notification_settings (setting_key, setting_value, description) VALUES
  ('routing.by_severity',
   '{"info":["mc_bell"],"warn":["mc_bell","discord"],"error":["mc_bell","discord"],"critical":["mc_bell","discord"]}'::jsonb,
   'Which sinks to fanout to per severity level'),
  ('discord.buttons_enabled',
   'true'::jsonb,
   'Master kill switch for Pete Bot v2 actionable buttons. false = render notifications without buttons.'),
  ('discord.button_timeout_seconds',
   '86400'::jsonb,
   'Default expiry for a Plan presented in Discord (24h). Per-plan override allowed at create time.'),
  ('discord.quiet_hours',
   '{"start_local":"23:00","end_local":"07:00","timezone":"America/Los_Angeles","action":"route_to_mc_bell"}'::jsonb,
   'During these hours, Discord notifications are suppressed and routed to MC bell only.'),
  ('actions.proposed_fix.discord_allowed',     'true'::jsonb,           'Per-kind: allow Discord rendering for agent-proposed fixes.'),
  ('actions.proposed_fix.required_group',      '"linux-admins"'::jsonb, 'Per-kind: Authentik group required to approve.'),
  ('actions.alert.discord_allowed',            'true'::jsonb,           'Per-kind: allow Discord rendering for alertmanager alerts.'),
  ('actions.alert.required_group',             '"linux-admins"'::jsonb, 'Per-kind: Authentik group required to ack/snooze.'),
  ('actions.gated_action.discord_allowed',     'false'::jsonb,          'GatedActions default to MC-only; opt-in to Discord per-deployment.'),
  ('actions.gated_action.required_group',      '"linux-admins"'::jsonb, NULL),
  ('actions.eval_regression.discord_allowed',  'true'::jsonb,           NULL),
  ('actions.eval_regression.required_group',   '"linux-admins"'::jsonb, NULL),
  ('actions.capacity_warning.discord_allowed', 'true'::jsonb,           NULL),
  ('actions.capacity_warning.required_group',  '"linux-admins"'::jsonb, NULL)
ON CONFLICT (setting_key) DO NOTHING;
