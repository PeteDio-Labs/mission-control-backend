/**
 * Agent Routes — /api/v1/agents
 *
 * Control plane for the agent platform. Agents call these to report
 * status and results; MC Web calls these to display state and approve/reject.
 *
 * GET    /api/v1/agents              — list agents (latest run per agent name)
 * POST   /api/v1/agents/:name/trigger — dispatch a named agent with a TaskPayload
 * GET    /api/v1/agents/history      — paginated run history (all agents)
 * GET    /api/v1/agents/:taskId      — fetch single run
 * POST   /api/v1/agents/:taskId/status  — agent reports status update
 * POST   /api/v1/agents/:taskId/result  — agent reports final result + artifacts
 * POST   /api/v1/agents/:taskId/approve — human approves a gated action
 * POST   /api/v1/agents/:taskId/reject  — human rejects a gated action
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  TaskPayloadSchema,
  AgentStatusUpdateSchema,
  AgentResultSchema,
} from '@petedio/shared/agents';
import {
  updateStatus,
  recordResult,
  resolveApproval,
  getRun,
  listRuns,
  listLatestByAgent,
} from '../../services/agentStore.js';
import { logger } from '../../utils/logger.js';
import type { TaskQueue } from '../../services/taskQueue.js';
import type { HealthChecker } from '../../services/healthChecker.js';

const router = Router();

// ─── GET /agents — live status panel (one row per agent name) ────

router.get('/', async (req: Request, res: Response) => {
  try {
    const rows = await listLatestByAgent();
    const healthChecker = req.app.locals.healthChecker as HealthChecker | undefined;
    const health = healthChecker?.getAllHealth() ?? {};
    const agents = rows.map(row => ({
      ...row,
      health: health[row.agent_name] ?? null,
    }));
    res.json({ agents });
  } catch (err) {
    logger.error('GET /agents failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// ─── GET /agents/history — paginated run history ─────────────────

router.get('/history', async (req: Request, res: Response) => {
  const QuerySchema = z.object({
    limit: z.coerce.number().min(1).max(200).default(50),
    offset: z.coerce.number().min(0).default(0),
    agent: z.string().optional(),
  });
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params', details: parsed.error.issues });
    return;
  }
  try {
    const runs = await listRuns({ limit: parsed.data.limit, offset: parsed.data.offset, agentName: parsed.data.agent });
    res.json({ runs, limit: parsed.data.limit, offset: parsed.data.offset });
  } catch (err) {
    logger.error('GET /agents/history failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ─── GET /agents/:taskId — single run ───────────────────────────

router.get('/:taskId', async (req: Request, res: Response) => {
  try {
    const run = await getRun(req.params.taskId!);
    if (!run) {
      res.status(404).json({ error: 'Run not found', taskId: req.params.taskId });
      return;
    }
    res.json({ run });
  } catch (err) {
    logger.error('GET /agents/:taskId failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch run' });
  }
});

// ─── POST /agents/:name/trigger — dispatch an agent ─────────────

router.post('/:name/trigger', async (req: Request, res: Response) => {
  const agentName = req.params.name!;
  const payload = {
    taskId: randomUUID(),
    agentName,
    trigger: req.body.trigger ?? 'manual',
    input: req.body.input ?? {},
    issuedAt: new Date().toISOString(),
  };

  const parsed = TaskPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid trigger payload', details: parsed.error.issues });
    return;
  }

  try {
    const taskQueue = req.app.locals.taskQueue as TaskQueue | undefined;
    if (!taskQueue) {
      res.status(503).json({ error: 'Task queue not initialised' });
      return;
    }
    await taskQueue.enqueue(parsed.data, { priority: 5 });
    logger.info('Agent triggered — enqueued', { agentName, taskId: parsed.data.taskId });
    res.status(202).json({ taskId: parsed.data.taskId, agentName, status: 'queued' });
  } catch (err) {
    logger.error('POST /agents/:name/trigger failed', { error: (err as Error).message, agentName });
    res.status(500).json({ error: 'Failed to enqueue agent task' });
  }
});

// ─── POST /agents/:taskId/status — agent reports status ─────────

router.post('/:taskId/status', async (req: Request, res: Response) => {
  const body = { ...req.body, taskId: req.params.taskId, updatedAt: new Date().toISOString() };
  const parsed = AgentStatusUpdateSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid status update', details: parsed.error.issues });
    return;
  }

  try {
    const run = await updateStatus(parsed.data);
    if (!run) {
      res.status(404).json({ error: 'Run not found', taskId: req.params.taskId });
      return;
    }
    res.json({ taskId: run.task_id, status: run.status });
  } catch (err) {
    logger.error('POST /agents/:taskId/status failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─── POST /agents/:taskId/result — agent reports final result ────

router.post('/:taskId/result', async (req: Request, res: Response) => {
  const body = { ...req.body, taskId: req.params.taskId, completedAt: new Date().toISOString() };
  const parsed = AgentResultSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid result payload', details: parsed.error.issues });
    return;
  }

  try {
    const run = await recordResult(parsed.data);
    if (!run) {
      res.status(404).json({ error: 'Run not found', taskId: req.params.taskId });
      return;
    }
    res.json({ taskId: run.task_id, status: run.status, completedAt: run.completed_at });
  } catch (err) {
    logger.error('POST /agents/:taskId/result failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to record result' });
  }
});

// ─── POST /agents/:taskId/approve ────────────────────────────────

router.post('/:taskId/approve', async (req: Request, res: Response) => {
  try {
    const run = await resolveApproval(req.params.taskId!, 'approved');
    if (!run) {
      res.status(404).json({ error: 'Run not found or not waiting for approval', taskId: req.params.taskId });
      return;
    }
    logger.info('Agent action approved', { taskId: req.params.taskId });
    res.json({ taskId: run.task_id, status: run.status, outcome: 'approved' });
  } catch (err) {
    logger.error('POST /agents/:taskId/approve failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// ─── POST /agents/:taskId/reject ─────────────────────────────────

router.post('/:taskId/reject', async (req: Request, res: Response) => {
  try {
    const run = await resolveApproval(req.params.taskId!, 'rejected');
    if (!run) {
      res.status(404).json({ error: 'Run not found or not waiting for approval', taskId: req.params.taskId });
      return;
    }
    logger.info('Agent action rejected', { taskId: req.params.taskId, reason: req.body.reason });
    res.json({ taskId: run.task_id, status: run.status, outcome: 'rejected' });
  } catch (err) {
    logger.error('POST /agents/:taskId/reject failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to reject' });
  }
});

export default router;
