/**
 * Roadmap Task service — TypeScript types shared between roadmapStore + REST routes.
 *
 * Mirrors the schema introduced in migration 007_roadmap_tasks.sql.
 * Keep these in sync with the SQL CHECK constraints — if either drifts, you'll
 * get a runtime error on first insert that violates a constraint.
 *
 * Vocabulary (see planning/MIGRATE-KANBAN-TO-MC.md glossary):
 *   - Roadmap Task = long-lived unit of work on the Master Plan (PB.10, RETRO.13)
 *   - Runtime Plan = short-lived actionable moment (alert, proposed_fix)
 *
 * The two relate via plans.roadmap_task_id (added in migration 008).
 */

export type RoadmapStatus =
  | 'backlog'
  | 'in-progress'
  | 'blocked'
  | 'awaiting-user'
  | 'done';

/**
 * Workstream IDs from planning/master-plan-kanban-types.ts WS_NAMES.
 * Kept loose (string) at the DB layer — display names live in MC Web.
 * This union is here for type-checking the importer + agent callers.
 */
export type WSId =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'AUTH' | 'EVAL' | 'RETRO' | 'PB' | 'SEC' | 'G';

export const ROADMAP_STATUSES: RoadmapStatus[] = [
  'backlog',
  'in-progress',
  'blocked',
  'awaiting-user',
  'done',
];

export const WS_IDS: WSId[] = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'AUTH', 'EVAL', 'RETRO', 'PB', 'SEC', 'G',
];

export type RoadmapEventType =
  | 'created'
  | 'status_change'
  | 'comment'
  | 'updated'
  | 'plan_linked';

// ─── DB row shapes (raw from Postgres) ────────────────────────────────

export interface RoadmapTaskRow {
  id: string;                        // 'PB.10', 'RETRO.13', '1.7'
  ws: string;                        // typed loosely; consumers narrow to WSId
  status: RoadmapStatus;
  effort: string;
  title: string;
  description: string;
  depends_on: string[];
  created_at: string;
  updated_at: string;
}

export interface RoadmapTaskEventRow {
  id: string;                        // BIGSERIAL — node-pg serializes as string
  task_id: string;
  event_type: RoadmapEventType;
  from_status: RoadmapStatus | null;
  to_status: RoadmapStatus | null;
  actor: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

// ─── Inputs to roadmapStore functions ─────────────────────────────────

export interface CreateRoadmapTaskInput {
  id: string;                        // caller-supplied (kanban ID)
  ws: string;
  status?: RoadmapStatus;            // defaults to 'backlog'
  effort?: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  actor?: string;                    // who created it; logged in the event row
}

export interface UpdateRoadmapTaskFieldsInput {
  taskId: string;
  ws?: string;
  effort?: string;
  title?: string;
  description?: string;
  dependsOn?: string[];
  actor?: string;
}

export interface UpdateRoadmapStatusInput {
  taskId: string;
  toStatus: RoadmapStatus;
  actor?: string;
}

export interface AppendEventInput {
  taskId: string;
  eventType: RoadmapEventType;
  fromStatus?: RoadmapStatus | null;
  toStatus?: RoadmapStatus | null;
  actor?: string | null;
  detail?: Record<string, unknown>;
}

export interface ListRoadmapTasksOpts {
  ws?: string | string[];
  status?: RoadmapStatus | RoadmapStatus[];
  limit?: number;
  offset?: number;
}

export interface BulkUpsertResult {
  imported: number;
  created: string[];
  updated: string[];
}
