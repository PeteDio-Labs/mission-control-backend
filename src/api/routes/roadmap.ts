/**
 * Roadmap Routes — /api/v1/roadmap/tasks
 *
 * MC-managed kanban surface. Sibling to /api/v1/plans but with a different
 * lifecycle (long-lived Master Plan items vs. short-lived Runtime Plans) and
 * a different auth model — ALL routes require authMiddleware + requireAdmin.
 *
 * Reference: planning/MIGRATE-KANBAN-TO-MC.md (Phase 1).
 *
 * Endpoints (all admin-gated):
 *   POST   /api/v1/roadmap/tasks                  — create one
 *   POST   /api/v1/roadmap/tasks/bulk             — bulk upsert (importer)
 *   GET    /api/v1/roadmap/tasks                  — list with ?ws=&status=
 *   GET    /api/v1/roadmap/tasks/:id              — detail + events + linked plans
 *   PATCH  /api/v1/roadmap/tasks/:id/status       — change status
 *   PATCH  /api/v1/roadmap/tasks/:id              — edit fields
 *   POST   /api/v1/roadmap/tasks/:id/events       — append comment
 *   DELETE /api/v1/roadmap/tasks/:id
 *
 * Mounted in routes/index.ts AFTER the global authMiddleware (unlike
 * /plans which mounts before — agents POST runtime plans, but the roadmap
 * is human-curated so no agent bypass is needed).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import db from '../../db/client.js';
import {
  createTask,
  getTask,
  getTaskEvents,
  listTasks,
  updateStatus,
  updateFields,
  deleteTask,
  logEvent,
  bulkUpsertTasks,
} from '../../services/roadmapStore.js';
import { logger } from '../../utils/logger.js';
import { requireAdmin } from '../../middleware/auth.js';

const router = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────

const RoadmapStatusSchema = z.enum([
  'backlog',
  'in-progress',
  'blocked',
  'awaiting-user',
  'done',
]);

// Workstream ID: loose at the schema level (the enum lives in MC Web)
// but constrained to a sensible shape — short alphanumeric tokens. This
// rejects accidental whitespace / paths but allows new workstreams to be
// added in MC Web without redeploying the backend.
const WsIdSchema = z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/);

// Task ID: kanban IDs like "1.1", "PB.10", "RETRO.13", "0.5". Allows the
// ws-dot-n pattern plus loose chars for ws prefixes.
const TaskIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

const CreateTaskBodySchema = z.object({
  id: TaskIdSchema,
  ws: WsIdSchema,
  status: RoadmapStatusSchema.optional(),
  effort: z.string().max(32).optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
  dependsOn: z.array(TaskIdSchema).max(32).optional(),
});

const BulkUpsertBodySchema = z.object({
  tasks: z.array(CreateTaskBodySchema).min(1).max(500),
});

const UpdateStatusBodySchema = z.object({
  toStatus: RoadmapStatusSchema,
  actor: z.string().max(200).optional(),
});

const UpdateFieldsBodySchema = z.object({
  ws: WsIdSchema.optional(),
  effort: z.string().max(32).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
  dependsOn: z.array(TaskIdSchema).max(32).optional(),
  actor: z.string().max(200).optional(),
});

const AppendEventBodySchema = z.object({
  eventType: z.enum(['comment']),  // POST only allows comment; other events are internal
  detail: z.record(z.unknown()).default({}),
  actor: z.string().max(200).optional(),
});

const ListQuerySchema = z.object({
  ws: z.union([WsIdSchema, z.array(WsIdSchema)]).optional(),
  status: z.union([RoadmapStatusSchema, z.array(RoadmapStatusSchema)]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── Helpers ─────────────────────────────────────────────────────────

function actorFromReq(req: Request, override?: string): string {
  return override ?? req.user?.email ?? 'unknown';
}

// ─── POST /tasks — create one ────────────────────────────────────────

router.post('/tasks', requireAdmin, async (req: Request, res: Response) => {
  const parsed = CreateTaskBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task body', details: parsed.error.issues });
    return;
  }

  try {
    const task = await createTask({ ...parsed.data, actor: actorFromReq(req) });
    res.status(201).json({ task });
  } catch (err) {
    const msg = (err as Error).message;
    // node-pg duplicate-key error code is 23505
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Task already exists', id: parsed.data.id });
      return;
    }
    logger.error('POST /roadmap/tasks failed', { error: msg });
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ─── POST /tasks/bulk — importer entry point ─────────────────────────

router.post('/tasks/bulk', requireAdmin, async (req: Request, res: Response) => {
  const parsed = BulkUpsertBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid bulk body', details: parsed.error.issues });
    return;
  }

  try {
    const result = await bulkUpsertTasks(parsed.data.tasks, actorFromReq(req, 'importer'));
    res.status(200).json(result);
  } catch (err) {
    logger.error('POST /roadmap/tasks/bulk failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to bulk upsert tasks' });
  }
});

// ─── GET /tasks — list ────────────────────────────────────────────────

router.get('/tasks', async (req: Request, res: Response) => {
  // Coerce comma-separated query strings into arrays
  const raw = { ...req.query } as Record<string, unknown>;
  if (typeof raw.ws === 'string' && raw.ws.includes(',')) raw.ws = (raw.ws as string).split(',');
  if (typeof raw.status === 'string' && (raw.status as string).includes(',')) {
    raw.status = (raw.status as string).split(',');
  }

  const parsed = ListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params', details: parsed.error.issues });
    return;
  }

  try {
    const tasks = await listTasks(parsed.data);
    res.json({ tasks, limit: parsed.data.limit, offset: parsed.data.offset });
  } catch (err) {
    logger.error('GET /roadmap/tasks failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// ─── GET /tasks/:id — detail + events + linked plans ─────────────────

router.get('/tasks/:id', async (req: Request, res: Response) => {
  const id = req.params.id!;
  try {
    const task = await getTask(id);
    if (!task) {
      res.status(404).json({ error: 'Task not found', id });
      return;
    }
    const events = await getTaskEvents(task.id);

    // Linked plans: pulls from /plans where roadmap_task_id = :id. The FK is
    // added in migration 008; until that lands, this query returns []. We
    // defensively wrap in a try so a missing column doesn't 500 the detail
    // page.
    let linkedPlans: Array<Record<string, unknown>> = [];
    try {
      linkedPlans = await db.queryMany(
        `SELECT id, kind, status, severity, summary, created_at, closed_at
         FROM plans
         WHERE roadmap_task_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [task.id],
      );
    } catch (err) {
      // Column may not exist yet (pre-migration-008). Don't fail the page.
      logger.debug('Linked plans query skipped (column missing?)', {
        taskId: task.id,
        error: (err as Error).message,
      });
    }

    res.json({ task, events, linkedPlans });
  } catch (err) {
    logger.error('GET /roadmap/tasks/:id failed', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// ─── PATCH /tasks/:id/status ─────────────────────────────────────────

router.patch('/tasks/:id/status', requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id!;
  const parsed = UpdateStatusBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid status body', details: parsed.error.issues });
    return;
  }

  try {
    const task = await updateStatus({
      taskId: id,
      toStatus: parsed.data.toStatus,
      actor: actorFromReq(req, parsed.data.actor),
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found', id });
      return;
    }
    res.json({ task });
  } catch (err) {
    logger.error('PATCH /roadmap/tasks/:id/status failed', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─── PATCH /tasks/:id — edit fields ──────────────────────────────────

router.patch('/tasks/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id!;
  const parsed = UpdateFieldsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid update body', details: parsed.error.issues });
    return;
  }

  try {
    const task = await updateFields({
      taskId: id,
      ...parsed.data,
      actor: actorFromReq(req, parsed.data.actor),
    });
    if (!task) {
      res.status(404).json({ error: 'Task not found', id });
      return;
    }
    res.json({ task });
  } catch (err) {
    logger.error('PATCH /roadmap/tasks/:id failed', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ─── POST /tasks/:id/events — append comment ─────────────────────────

router.post('/tasks/:id/events', requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id!;
  const parsed = AppendEventBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event body', details: parsed.error.issues });
    return;
  }

  // Verify task exists before logging
  const task = await getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found', id });
    return;
  }

  try {
    const event = await logEvent({
      taskId: id,
      eventType: parsed.data.eventType,
      actor: actorFromReq(req, parsed.data.actor),
      detail: parsed.data.detail,
    });
    res.status(201).json({ event });
  } catch (err) {
    logger.error('POST /roadmap/tasks/:id/events failed', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to append event' });
  }
});

// ─── DELETE /tasks/:id ───────────────────────────────────────────────

router.delete('/tasks/:id', requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id!;
  try {
    const ok = await deleteTask(id);
    if (!ok) {
      res.status(404).json({ error: 'Task not found', id });
      return;
    }
    res.status(204).end();
  } catch (err) {
    logger.error('DELETE /roadmap/tasks/:id failed', { id, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

export default router;
