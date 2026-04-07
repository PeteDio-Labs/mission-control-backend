/**
 * Agent Store
 * DB-backed store for agent run lifecycle:
 *   - insertRun       → called by trigger endpoint
 *   - updateStatus    → called by agent status updates
 *   - recordResult    → called when agent completes
 *   - setPendingApproval → called when agent needs approval
 *   - resolveApproval → called by approve/reject endpoints
 *   - getRun          → fetch single run by taskId
 *   - listRuns        → paginated history
 *   - listLatestByAgent → current status per agent name
 */

import db from '../db/client.js';
import { logger } from '../utils/logger.js';
import type {
  TaskPayload,
  AgentStatusUpdate,
  AgentResult,
  GatedAction,
  ApprovalOutcome,
} from '@petedio/shared/agents';

// ─── Row shape from DB ────────────────────────────────────────────

export interface AgentRunRow {
  id: string;
  task_id: string;
  agent_name: string;
  trigger: string;
  status: string;
  input: Record<string, unknown>;
  result: AgentResult | null;
  pending_approval: GatedAction | null;
  summary: string | null;
  issued_at: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

// ─── Insert (on trigger) ─────────────────────────────────────────

export async function insertRun(payload: TaskPayload): Promise<AgentRunRow> {
  const row = await db.queryOne<AgentRunRow>(
    `INSERT INTO agent_runs (task_id, agent_name, trigger, input, issued_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [payload.taskId, payload.agentName, payload.trigger, JSON.stringify(payload.input), payload.issuedAt],
  );
  if (!row) throw new Error('Failed to insert agent run');
  logger.info('Agent run inserted', { taskId: payload.taskId, agentName: payload.agentName });
  return row;
}

// ─── Status update (from agent) ──────────────────────────────────

export async function updateStatus(update: AgentStatusUpdate): Promise<AgentRunRow | null> {
  // UPSERT — self-triggered runs (cron, event, api) generate their own taskId before
  // registering with MC, so the row may not exist yet on first status report.
  const row = await db.queryOne<AgentRunRow>(
    `INSERT INTO agent_runs (task_id, agent_name, trigger, input, issued_at, status)
     VALUES ($3, $4, 'manual', '{}', NOW(), $1)
     ON CONFLICT (task_id) DO UPDATE
       SET status = $1,
           pending_approval = CASE WHEN $2::jsonb IS NOT NULL THEN $2::jsonb ELSE agent_runs.pending_approval END
     RETURNING *`,
    [
      update.status,
      update.requiresApproval ? JSON.stringify(update.requiresApproval) : null,
      update.taskId,
      update.agentName,
    ],
  );
  if (!row) logger.warn('updateStatus: upsert returned no row', { taskId: update.taskId });
  return row;
}

// ─── Record final result (from agent) ────────────────────────────

export async function recordResult(result: AgentResult): Promise<AgentRunRow | null> {
  const row = await db.queryOne<AgentRunRow>(
    `UPDATE agent_runs
     SET status = $1,
         result = $2::jsonb,
         summary = $3,
         completed_at = NOW(),
         duration_ms = $4,
         pending_approval = NULL
     WHERE task_id = $5
     RETURNING *`,
    [
      result.status,
      JSON.stringify(result),
      result.summary,
      result.durationMs,
      result.taskId,
    ],
  );
  if (!row) logger.warn('recordResult: run not found', { taskId: result.taskId });
  return row;
}

// ─── Approval resolution ─────────────────────────────────────────

export async function resolveApproval(
  taskId: string,
  outcome: ApprovalOutcome,
): Promise<AgentRunRow | null> {
  const newStatus = outcome === 'approved' ? 'running' : 'failed';
  const row = await db.queryOne<AgentRunRow>(
    `UPDATE agent_runs
     SET status = $1,
         pending_approval = NULL
     WHERE task_id = $2 AND status = 'waiting_approval'
     RETURNING *`,
    [newStatus, taskId],
  );
  if (!row) logger.warn('resolveApproval: run not found or not waiting', { taskId, outcome });
  return row;
}

// ─── Queries ─────────────────────────────────────────────────────

export async function getRun(taskId: string): Promise<AgentRunRow | null> {
  return db.queryOne<AgentRunRow>(
    `SELECT * FROM agent_runs WHERE task_id = $1`,
    [taskId],
  );
}

export async function listRuns(opts: { limit?: number; offset?: number; agentName?: string } = {}): Promise<AgentRunRow[]> {
  const { limit = 50, offset = 0, agentName } = opts;
  if (agentName) {
    return db.queryMany<AgentRunRow>(
      `SELECT * FROM agent_runs WHERE agent_name = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [agentName, limit, offset],
    );
  }
  return db.queryMany<AgentRunRow>(
    `SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

/** Returns the most recent run per agent name — used for the live status panel */
export async function listLatestByAgent(): Promise<AgentRunRow[]> {
  return db.queryMany<AgentRunRow>(
    `SELECT DISTINCT ON (agent_name) *
     FROM agent_runs
     ORDER BY agent_name, created_at DESC`,
  );
}
