/**
 * Plan service — TypeScript types shared between planStore + planService + REST routes.
 *
 * Mirrors the schema introduced in migration 005_pb_v2_plans.sql.
 * Keep these in sync with the SQL CHECK constraints — if either drifts, you'll
 * get a runtime error on first insert that violates a constraint.
 */

import type { PlanStatus } from './stateMachine.js';

export type PlanKind =
  | 'proposed_fix'
  | 'alert'
  | 'gated_action'
  | 'eval_regression'
  | 'capacity_warning';

export type PlanSeverity = 'info' | 'warn' | 'error' | 'critical';

export type PlanSource = 'agent' | 'alertmanager' | 'user' | 'cron' | 'external';

export type ActorSource = 'discord' | 'mc_web' | 'mc_desktop' | 'api' | 'system' | 'agent';

export type ApprovalSurface = 'discord' | 'mc_web' | 'mc_desktop' | 'api';

export type ButtonStyle = 'primary' | 'secondary' | 'danger' | 'link';

// ─── DB row shapes (raw from Postgres) ────────────────────────────────

export interface PlanRow {
  id: string;
  kind: PlanKind;
  status: PlanStatus;
  severity: PlanSeverity;
  source: PlanSource;
  source_metadata: Record<string, unknown>;
  target: string | null;
  summary: string;
  proposed_fix: ProposedFix | null;
  triggered_agent_run_id: string | null;
  approved_by_mc_user_id: string | null;
  approved_via: ApprovalSurface | null;
  result: Record<string, unknown> | null;
  error_summary: string | null;
  proposals: StuckProposal[] | null;
  expires_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanActionRow {
  plan_id: string;
  action_id: string;
  label: string;
  style: ButtonStyle;
  ordering: number;
  click_payload: Record<string, unknown>;
  acted_at: string | null;
  acted_by_user: string | null;
  created_at: string;
}

export interface PlanEventRow {
  id: string; // BIGSERIAL serializes as string in node-pg by default
  plan_id: string;
  event_type:
    | 'created'
    | 'presented'
    | 'clicked'
    | 'dispatched'
    | 'state_change'
    | 'agent_progress'
    | 'succeeded'
    | 'failed'
    | 'stuck'
    | 'dismissed'
    | 'expired'
    | 'resolved'
    | 'comment'
    | 'duplicate_click';
  action_id: string | null;
  actor_user_id: string | null;
  actor_source: ActorSource | null;
  from_status: PlanStatus | null;
  to_status: PlanStatus | null;
  detail: Record<string, unknown>;
  occurred_at: string;
}

// ─── Inputs to planStore functions ─────────────────────────────────────

export interface ProposedFix {
  agent: string;            // e.g. 'devops-engineer'
  task: string;             // human-readable summary of what the agent should do
  input?: Record<string, unknown>; // optional TaskPayload.input for the dispatch
}

export interface StuckProposal {
  label: string;            // 'Try ISP power-cycle'
  task?: string;            // optional auto-dispatchable task
  mcUrl?: string;           // optional deep-link if user should debug manually
}

export interface SuggestedAction {
  actionId: string;         // 'yes' | 'dismiss' | 'snooze_1h' | ...
  label: string;            // 'Fix it'
  style?: ButtonStyle;
  clickPayload?: Record<string, unknown>;
}

export interface CreatePlanInput {
  id?: string;              // optional override; default = generatePlanId()
  kind: PlanKind;
  severity?: PlanSeverity;
  source: PlanSource;
  sourceMetadata?: Record<string, unknown>;
  target?: string;
  summary: string;
  proposedFix?: ProposedFix;
  actions: SuggestedAction[];
  expiresAt?: Date;
}

export interface TransitionInput {
  planId: string;
  toStatus: PlanStatus;
  actorUserId?: string;
  actorSource: ActorSource;
  payload?: {
    result?: Record<string, unknown>;
    errorSummary?: string;
    proposals?: StuckProposal[];
  };
}

// ─── recordClick result discriminated union ────────────────────────────

export type RecordClickResult =
  | { ok: true; action: PlanActionRow }
  | { ok: false; reason: 'plan_not_found' }
  | { ok: false; reason: 'action_not_found' }
  | { ok: false; reason: 'plan_closed'; currentStatus: PlanStatus }
  | {
      ok: false;
      reason: 'duplicate';
      currentStatus: PlanStatus;
      previouslyActedBy: string | null;
      previouslyActedAt: string | null;
    };
