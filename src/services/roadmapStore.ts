/**
 * Roadmap Store — MC-managed kanban backing store.
 *
 * Sibling to planStore.ts. Same architectural pattern (DB-backed CRUD + event
 * log + transaction-wrapped mutations) for a different domain:
 *
 *   - planStore    → short-lived Runtime Plans with a strict state machine
 *   - roadmapStore → long-lived Master Plan items with free-flowing status
 *
 * The two relate via plans.roadmap_task_id (migration 008). When a Plan is
 * created with a roadmap_task_id, we emit a 'plan_linked' event on this side
 * (logEvent called from planStore.createPlan).
 *
 * Functions:
 *   - upsertTask          → importer uses this; ON CONFLICT (id) DO UPDATE
 *   - createTask          → strict create; errors on duplicate id
 *   - getTask             → fetch by id
 *   - getTaskEvents       → timeline
 *   - listTasks           → filter by ws / status
 *   - updateStatus        → free-flowing; writes status_change event
 *   - updateFields        → patch title/description/effort/ws/depends_on
 *   - deleteTask          → cascades to events (FK ON DELETE CASCADE)
 *   - logEvent            → manual event append (comment, plan_linked)
 *   - bulkUpsertTasks     → batch importer entry point
 */

import db from '../db/client.js';
import { logger } from '../utils/logger.js';
import type {
  RoadmapTaskRow,
  RoadmapTaskEventRow,
  RoadmapStatus,
  CreateRoadmapTaskInput,
  UpdateRoadmapStatusInput,
  UpdateRoadmapTaskFieldsInput,
  AppendEventInput,
  ListRoadmapTasksOpts,
  BulkUpsertResult,
} from './roadmap/types.js';

// ─── Create / upsert ─────────────────────────────────────────────────

export async function createTask(input: CreateRoadmapTaskInput): Promise<RoadmapTaskRow> {
  return db.transaction(async (client) => {
    const result = await client.query<RoadmapTaskRow>(
      `INSERT INTO roadmap_tasks (id, ws, status, effort, title, description, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.ws,
        input.status ?? 'backlog',
        input.effort ?? '',
        input.title,
        input.description ?? '',
        input.dependsOn ?? [],
      ],
    );
    const task = result.rows[0]!;

    await client.query(
      `INSERT INTO roadmap_task_events (task_id, event_type, to_status, actor, detail)
       VALUES ($1, 'created', $2, $3, $4::jsonb)`,
      [
        task.id,
        task.status,
        input.actor ?? 'system',
        JSON.stringify({ ws: task.ws, title: task.title }),
      ],
    );

    logger.info('Roadmap task created', { id: task.id, ws: task.ws, status: task.status });
    return task;
  });
}

/**
 * Upsert — used by the bulk importer. Re-runs are safe: existing rows are
 * updated in place, new rows are inserted. status is preserved if the caller
 * doesn't pass one (we don't want the importer to clobber a status that was
 * advanced via MC after the initial seed).
 *
 * Returns { inserted: boolean } so the bulk caller can count creates vs updates.
 */
export async function upsertTask(
  input: CreateRoadmapTaskInput,
): Promise<{ task: RoadmapTaskRow; inserted: boolean }> {
  return db.transaction(async (client) => {
    // Check existence first to know whether we're inserting or updating.
    // ON CONFLICT can't tell us this directly without xmax tricks.
    const existing = await client.query<{ id: string; status: RoadmapStatus }>(
      `SELECT id, status FROM roadmap_tasks WHERE id = $1`,
      [input.id],
    );
    const inserted = existing.rowCount === 0;

    const result = await client.query<RoadmapTaskRow>(
      `INSERT INTO roadmap_tasks (id, ws, status, effort, title, description, depends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         ws          = EXCLUDED.ws,
         effort      = EXCLUDED.effort,
         title       = EXCLUDED.title,
         description = EXCLUDED.description,
         depends_on  = EXCLUDED.depends_on
         -- NOTE: status intentionally NOT updated on conflict; preserves
         -- MC-side status edits made after the original import.
       RETURNING *`,
      [
        input.id,
        input.ws,
        input.status ?? 'backlog',
        input.effort ?? '',
        input.title,
        input.description ?? '',
        input.dependsOn ?? [],
      ],
    );
    const task = result.rows[0]!;

    await client.query(
      `INSERT INTO roadmap_task_events (task_id, event_type, to_status, actor, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        task.id,
        inserted ? 'created' : 'updated',
        task.status,
        input.actor ?? 'importer',
        JSON.stringify({ ws: task.ws, title: task.title, source: 'bulk_upsert' }),
      ],
    );

    return { task, inserted };
  });
}

// ─── Read ─────────────────────────────────────────────────────────────

export async function getTask(taskId: string): Promise<RoadmapTaskRow | null> {
  return db.queryOne<RoadmapTaskRow>(
    `SELECT * FROM roadmap_tasks WHERE id = $1`,
    [taskId],
  );
}

export async function getTaskEvents(taskId: string, limit = 200): Promise<RoadmapTaskEventRow[]> {
  return db.queryMany<RoadmapTaskEventRow>(
    `SELECT * FROM roadmap_task_events
     WHERE task_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    [taskId, limit],
  );
}

export async function listTasks(opts: ListRoadmapTasksOpts = {}): Promise<RoadmapTaskRow[]> {
  const conditions: string[] = [];
  const params: Array<string | number | string[]> = [];

  if (opts.ws) {
    const arr = Array.isArray(opts.ws) ? opts.ws : [opts.ws];
    params.push(arr);
    conditions.push(`ws = ANY($${params.length}::text[])`);
  }
  if (opts.status) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
    params.push(arr);
    conditions.push(`status = ANY($${params.length}::text[])`);
  }

  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM roadmap_tasks ${where}
               ORDER BY updated_at DESC
               LIMIT $${params.length - 1} OFFSET $${params.length}`;

  return db.queryMany<RoadmapTaskRow>(sql, params);
}

// ─── Update ───────────────────────────────────────────────────────────

export async function updateStatus(
  input: UpdateRoadmapStatusInput,
): Promise<RoadmapTaskRow | null> {
  const { taskId, toStatus, actor } = input;

  return db.transaction(async (client) => {
    const cur = await client.query<RoadmapTaskRow>(
      `SELECT * FROM roadmap_tasks WHERE id = $1 FOR UPDATE`,
      [taskId],
    );
    if (cur.rowCount === 0) return null;
    const before = cur.rows[0]!;

    // No state-machine validation — roadmap statuses are free-flowing.
    // No-op detection: don't write a status_change event if status hasn't changed.
    if (before.status === toStatus) {
      return before;
    }

    const upd = await client.query<RoadmapTaskRow>(
      `UPDATE roadmap_tasks SET status = $2 WHERE id = $1 RETURNING *`,
      [taskId, toStatus],
    );

    await client.query(
      `INSERT INTO roadmap_task_events (task_id, event_type, from_status, to_status, actor)
       VALUES ($1, 'status_change', $2, $3, $4)`,
      [taskId, before.status, toStatus, actor ?? 'system'],
    );

    logger.info('Roadmap task status changed', {
      id: taskId,
      from: before.status,
      to: toStatus,
      actor: actor ?? 'system',
    });

    return upd.rows[0]!;
  });
}

export async function updateFields(
  input: UpdateRoadmapTaskFieldsInput,
): Promise<RoadmapTaskRow | null> {
  const { taskId, actor } = input;

  // Build the SET clause from defined fields only — undefined fields are
  // left untouched. This lets PATCH callers omit fields they don't want to change.
  const sets: string[] = [];
  const params: Array<string | string[]> = [];

  if (input.ws !== undefined) {
    params.push(input.ws);
    sets.push(`ws = $${params.length + 1}`);
  }
  if (input.effort !== undefined) {
    params.push(input.effort);
    sets.push(`effort = $${params.length + 1}`);
  }
  if (input.title !== undefined) {
    params.push(input.title);
    sets.push(`title = $${params.length + 1}`);
  }
  if (input.description !== undefined) {
    params.push(input.description);
    sets.push(`description = $${params.length + 1}`);
  }
  if (input.dependsOn !== undefined) {
    params.push(input.dependsOn);
    sets.push(`depends_on = $${params.length + 1}`);
  }

  if (sets.length === 0) {
    return getTask(taskId);
  }

  return db.transaction(async (client) => {
    const cur = await client.query<RoadmapTaskRow>(
      `SELECT * FROM roadmap_tasks WHERE id = $1 FOR UPDATE`,
      [taskId],
    );
    if (cur.rowCount === 0) return null;

    const upd = await client.query<RoadmapTaskRow>(
      `UPDATE roadmap_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [taskId, ...params],
    );

    await client.query(
      `INSERT INTO roadmap_task_events (task_id, event_type, actor, detail)
       VALUES ($1, 'updated', $2, $3::jsonb)`,
      [taskId, actor ?? 'system', JSON.stringify({ fields: sets.map((s) => s.split(' ')[0]) })],
    );

    return upd.rows[0]!;
  });
}

// ─── Delete ───────────────────────────────────────────────────────────

export async function deleteTask(taskId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM roadmap_tasks WHERE id = $1`,
    [taskId],
  );
  if ((result.rowCount ?? 0) > 0) {
    logger.info('Roadmap task deleted', { id: taskId });
    return true;
  }
  return false;
}

// ─── Event log ────────────────────────────────────────────────────────

/**
 * Manual event append. Used for 'comment' events from MC Web and
 * 'plan_linked' events emitted by planStore.createPlan when a Runtime Plan
 * is created with a roadmap_task_id.
 */
export async function logEvent(input: AppendEventInput): Promise<RoadmapTaskEventRow> {
  const row = await db.queryOne<RoadmapTaskEventRow>(
    `INSERT INTO roadmap_task_events (task_id, event_type, from_status, to_status, actor, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.taskId,
      input.eventType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.actor ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  if (!row) throw new Error('logEvent: insert returned no row');
  return row;
}

// ─── Bulk upsert ──────────────────────────────────────────────────────

export async function bulkUpsertTasks(
  tasks: CreateRoadmapTaskInput[],
  actor = 'importer',
): Promise<BulkUpsertResult> {
  const created: string[] = [];
  const updated: string[] = [];

  for (const t of tasks) {
    const { inserted } = await upsertTask({ ...t, actor });
    if (inserted) created.push(t.id);
    else updated.push(t.id);
  }

  logger.info('Roadmap bulk upsert', {
    total: tasks.length,
    created: created.length,
    updated: updated.length,
  });

  return { imported: tasks.length, created, updated };
}

// Re-export types so callers can import everything from one place
export type {
  RoadmapTaskRow,
  RoadmapTaskEventRow,
  RoadmapStatus,
  CreateRoadmapTaskInput,
  UpdateRoadmapStatusInput,
  UpdateRoadmapTaskFieldsInput,
  AppendEventInput,
  ListRoadmapTasksOpts,
  BulkUpsertResult,
};
