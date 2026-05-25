/**
 * Plan Routes — /api/v1/plans
 *
 * Pete Bot v2 Plan service REST surface (PB.3).
 *
 * Agent / system callers (no user auth — agent-to-MC over cluster network):
 *   POST   /api/v1/plans                       — create plan (agents via proposeAction(), alertmanager, etc.)
 *   PATCH  /api/v1/plans/:id/status            — agent updates plan status (succeeded/failed/stuck/in_progress)
 *   POST   /api/v1/plans/:id/events            — agent appends progress / comment events
 *   GET    /api/v1/plans/expired-presented     — PB.8: Pete Bot expiry sweep — fetch + lazily mark presented
 *                                                plans whose expires_at has lapsed. Side-effect: each returned
 *                                                plan is transitioned presented → expired before the response.
 *
 * Human / MC Web callers (auth required):
 *   GET    /api/v1/plans                       — list plans (filter by status/kind/active)
 *   GET    /api/v1/plans/:id                   — single plan + actions + events
 *   POST   /api/v1/plans/:id/actions/:actionId — act on plan (approve/dismiss/etc.) — also requireAdmin
 *
 * Mounted under apiV1Router BEFORE the global authMiddleware (same pattern as
 * /agents) so agent-facing routes bypass user auth. Human-facing routes apply
 * authMiddleware (and requireAdmin where mutating) per-route.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createPlan,
  recordClick,
  dispatchPlan,
  transitionStatus,
  getPlan,
  getPlanActions,
  getPlanEvents,
  listPlans,
  listExpiredPresented,
  logEvent,
} from '../../services/planStore.js';
import { notifyPlan } from '../../services/notifications/router.js';
import { logger } from '../../utils/logger.js';
import { authMiddleware, requireAdmin } from '../../middleware/auth.js';

const router = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────

const PlanKindSchema = z.enum([
  'proposed_fix',
  'alert',
  'gated_action',
  'eval_regression',
  'capacity_warning',
]);

const PlanStatusSchema = z.enum([
  'pending', 'presented', 'clicked', 'dispatched', 'in_progress',
  'succeeded', 'failed', 'stuck', 'resolved', 'dismissed', 'expired',
]);

const SeveritySchema = z.enum(['info', 'warn', 'error', 'critical']);
const SourceSchema = z.enum(['agent', 'alertmanager', 'user', 'cron', 'external']);
const ButtonStyleSchema = z.enum(['primary', 'secondary', 'danger', 'link']);

const ActionInputSchema = z.object({
  actionId: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  style: ButtonStyleSchema.optional(),
  clickPayload: z.record(z.unknown()).optional(),
});

const CreatePlanBodySchema = z.object({
  id: z.string().regex(/^pl_[a-zA-Z0-9_-]{4,64}$/).optional(),
  kind: PlanKindSchema,
  severity: SeveritySchema.optional(),
  source: SourceSchema,
  sourceMetadata: z.record(z.unknown()).optional(),
  target: z.string().max(200).optional(),
  summary: z.string().min(1).max(2000),
  proposedFix: z.object({
    agent: z.string(),
    task: z.string(),
    input: z.record(z.unknown()).optional(),
  }).optional(),
  actions: z.array(ActionInputSchema).min(1).max(8),
  expiresInSeconds: z.number().int().min(60).max(7 * 24 * 60 * 60).optional(),
});

const TransitionStatusBodySchema = z.object({
  toStatus: PlanStatusSchema,
  actorUserId: z.string().optional(),
  actorSource: z.enum(['discord', 'mc_web', 'mc_desktop', 'api', 'system', 'agent']),
  result: z.record(z.unknown()).optional(),
  errorSummary: z.string().max(2000).optional(),
  proposals: z.array(z.object({
    label: z.string(),
    task: z.string().optional(),
    mcUrl: z.string().url().optional(),
  })).optional(),
  triggeredAgentRunId: z.string().uuid().optional(),
});

const EventBodySchema = z.object({
  eventType: z.enum(['agent_progress', 'comment']),
  actorUserId: z.string().nullable().optional(),
  actorSource: z.enum(['discord', 'mc_web', 'mc_desktop', 'api', 'system', 'agent']),
  detail: z.record(z.unknown()).default({}),
});

const ActOnPlanBodySchema = z.object({
  actorUserId: z.string().min(1).optional(),
}).optional();

// ─── POST /plans — create plan (agent-facing) ────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const parsed = CreatePlanBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid plan body', details: parsed.error.issues });
    return;
  }
  try {
    const { expiresInSeconds, ...rest } = parsed.data;
    const expiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : undefined;
    const plan = await createPlan({ ...rest, expiresAt });

    // RETRO.17: fire-and-forget notification dispatch. The plan is already
    // persisted; if Pete Bot is down or the SSE bus fails, the plan stays in
    // 'pending' and a future expiry sweep / manual nudge will retry.
    notifyPlan(plan).catch((err) => {
      logger.error('notifyPlan failed (fire-and-forget)', {
        planId: plan.id,
        error: (err as Error).message,
      });
    });

    res.status(201).json({ plan, planId: plan.id });
  } catch (err) {
    logger.error('POST /plans failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// ─── PATCH /plans/:id/status — agent status update (agent-facing) ─────

router.patch('/:id/status', async (req: Request, res: Response) => {
  const parsed = TransitionStatusBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid status body', details: parsed.error.issues });
    return;
  }
  try {
    const { toStatus, actorUserId, actorSource, triggeredAgentRunId, ...payload } = parsed.data;

    // If the agent is reporting "dispatched" and providing an agent_run_id,
    // use dispatchPlan to link the run; otherwise just transition.
    let plan;
    if (toStatus === 'dispatched' && triggeredAgentRunId) {
      plan = await dispatchPlan({ planId: req.params.id!, agentRunId: triggeredAgentRunId });
    } else {
      plan = await transitionStatus({
        planId: req.params.id!,
        toStatus,
        actorUserId,
        actorSource,
        payload,
      });
    }

    if (!plan) {
      res.status(404).json({ error: 'Plan not found', planId: req.params.id });
      return;
    }
    res.json({ plan });
  } catch (err) {
    logger.error('PATCH /plans/:id/status failed', {
      planId: req.params.id,
      error: (err as Error).message,
    });
    res.status(500).json({ error: 'Failed to transition plan' });
  }
});

// ─── POST /plans/:id/events — agent progress / comment (agent-facing) ──

router.post('/:id/events', async (req: Request, res: Response) => {
  const parsed = EventBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid event body', details: parsed.error.issues });
    return;
  }
  try {
    const event = await logEvent({
      planId: req.params.id!,
      eventType: parsed.data.eventType,
      actorUserId: parsed.data.actorUserId ?? null,
      actorSource: parsed.data.actorSource,
      detail: parsed.data.detail,
    });
    res.status(201).json({ event });
  } catch (err) {
    logger.error('POST /plans/:id/events failed', {
      planId: req.params.id,
      error: (err as Error).message,
    });
    res.status(500).json({ error: 'Failed to log event' });
  }
});

// ─── GET /plans/expired-presented — Pete Bot expiry sweep (PB.8) ──────
// Agent-facing (no authMiddleware): in-cluster call from Pete Bot's
// background sweep. Returns plans whose status is still 'presented' but
// whose expires_at has lapsed, then lazily transitions each one to
// 'expired' before the response is sent.
//
// Why lazy: keeps the state machine the single source of truth for
// "is this plan still actionable?" without a dedicated cron in MC. The
// sweep is idempotent — re-fetching the same plan after transition no
// longer satisfies the WHERE clause and won't be returned again.
//
// Mounted ABOVE the auth-gated `GET /` so it bypasses authMiddleware.
// Pattern matches the other agent-facing routes (POST `/`, PATCH
// `/:id/status`, POST `/:id/events`) declared earlier in this file.

router.get('/expired-presented', async (req: Request, res: Response) => {
  const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
  });
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params', details: parsed.error.issues });
    return;
  }

  try {
    const expired = await listExpiredPresented(parsed.data.limit);

    // Lazy transition: for each presented-and-lapsed plan, fire the
    // state-machine move presented → expired. transitionStatus is
    // idempotent at the state-machine layer (it rejects invalid
    // transitions and logs a warning) so a concurrent run that already
    // moved the plan is harmless.
    //
    // Return the post-transition rows when available so the caller sees
    // status='expired' and doesn't re-edit the Discord message on the
    // next sweep tick. If the transition is rejected (race, already
    // closed) we still return the pre-transition row — the caller's
    // edit is idempotent (message.edit({components: []}) twice is
    // identical to once).
    const plans = await Promise.all(
      expired.map(async (plan) => {
        try {
          const transitioned = await transitionStatus({
            planId: plan.id,
            toStatus: 'expired',
            actorSource: 'system',
            payload: {},
          });
          return transitioned ?? plan;
        } catch (err) {
          logger.error('GET /plans/expired-presented: transitionStatus failed', {
            planId: plan.id,
            error: (err as Error).message,
          });
          // Surface the original row so the caller can still edit Discord
          return plan;
        }
      }),
    );

    res.json({ plans });
  } catch (err) {
    logger.error('GET /plans/expired-presented failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list expired-presented plans' });
  }
});

// ─── GET /plans/:id/agent-status — agent poll for plan progress (PB.10) ─
// Agent-facing (no authMiddleware): in-cluster / cross-LAN call from cron
// watchdogs that need to know whether their plan was clicked, dismissed,
// or expired without exposing the full event timeline.
//
// Returns the minimum needed for a polling agent:
//   - status              — current plan status (presented/clicked/expired/…)
//   - lastClickedActionId — the actionId the user picked (null until clicked)
//   - actedBy             — who clicked (audit)
//   - updatedAt/closedAt  — for clients that want to detect change
//
// Mounted ABOVE the auth-gated `GET /` (and ABOVE the param route
// `GET /:id`) so it bypasses authMiddleware. Pattern matches the other
// agent-facing routes (POST `/`, PATCH `/:id/status`, POST `/:id/events`,
// GET `/expired-presented`) declared earlier in this file.

router.get('/:id/agent-status', async (req: Request, res: Response) => {
  try {
    const plan = await getPlan(req.params.id!);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found', planId: req.params.id });
      return;
    }
    const actions = await getPlanActions(plan.id);
    const claimed = actions.find((a) => a.acted_at !== null);
    res.json({
      planId: plan.id,
      status: plan.status,
      lastClickedActionId: claimed?.action_id ?? null,
      actedBy: claimed?.acted_by_user ?? null,
      updatedAt: plan.updated_at,
      closedAt: plan.closed_at,
    });
  } catch (err) {
    logger.error('GET /plans/:id/agent-status failed', {
      planId: req.params.id,
      error: (err as Error).message,
    });
    res.status(500).json({ error: 'Failed to fetch agent status' });
  }
});

// ─── GET /plans — list (user-facing, auth required) ──────────────────

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const QuerySchema = z.object({
    status: z.union([PlanStatusSchema, z.array(PlanStatusSchema)]).optional(),
    kind: z.union([PlanKindSchema, z.array(PlanKindSchema)]).optional(),
    source: SourceSchema.optional(),
    active: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });

  // Coerce status/kind to arrays if passed as comma-separated string
  const raw = { ...req.query };
  if (typeof raw.status === 'string' && raw.status.includes(',')) raw.status = raw.status.split(',');
  if (typeof raw.kind === 'string' && raw.kind.includes(',')) raw.kind = raw.kind.split(',');

  const parsed = QuerySchema.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params', details: parsed.error.issues });
    return;
  }

  try {
    const plans = await listPlans(parsed.data);
    res.json({ plans, limit: parsed.data.limit, offset: parsed.data.offset });
  } catch (err) {
    logger.error('GET /plans failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list plans' });
  }
});

// ─── GET /plans/:id — detail (user-facing, auth required) ────────────

router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const plan = await getPlan(req.params.id!);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found', planId: req.params.id });
      return;
    }
    const [actions, events] = await Promise.all([
      getPlanActions(plan.id),
      getPlanEvents(plan.id),
    ]);
    res.json({ plan, actions, events });
  } catch (err) {
    logger.error('GET /plans/:id failed', {
      planId: req.params.id,
      error: (err as Error).message,
    });
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// ─── Generic action → close-status map (PB.13) ────────────────────────
// For actions whose semantics are "close the plan in <state>", drive a
// follow-up transitionStatus from this small map after recordClick succeeds.
// Keeps the handler generic; new self-closing actions just add a key.
//
// FOLLOW-UP: snooze_1h maps to 'dismissed' because v2 has no snooze-then-
// re-present mechanism. Proper snooze should requeue the plan for re-notify
// after 1h instead of closing it. Tracked as a retro candidate.
const ACTION_CLOSE_MAP: Record<string, 'resolved' | 'dismissed'> = {
  ack: 'resolved',
  snooze_1h: 'dismissed',
};

// ─── POST /plans/:id/actions/:actionId — act on plan (auth + admin) ───
// Used by MC Web; the Discord click path goes through /discord/callback
// which calls recordClick directly. Returns 200 on first click,
// 409 on duplicate, 410 on plan_closed, 404 on plan_not_found.

router.post(
  '/:id/actions/:actionId',
  authMiddleware,
  requireAdmin,
  async (req: Request, res: Response) => {
    const parsed = ActOnPlanBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
      return;
    }
    const actorUserId = parsed.data?.actorUserId ?? req.user?.email ?? 'unknown';

    try {
      const result = await recordClick({
        planId: req.params.id!,
        actionId: req.params.actionId!,
        actorUserId,
        actorSource: 'mc_web',
      });

      if (result.ok) {
        // PB.13: self-closing actions (ack / snooze_1h) transition the plan
        // to a terminal state after the click is recorded. We don't fail the
        // request if the transition is rejected (e.g. plan already terminal
        // via another path) — transitionStatus logs the no-op.
        const targetStatus = ACTION_CLOSE_MAP[req.params.actionId!];
        let closedPlan = null;
        if (targetStatus) {
          try {
            closedPlan = await transitionStatus({
              planId: req.params.id!,
              toStatus: targetStatus,
              actorUserId,
              actorSource: 'mc_web',
            });
          } catch (err) {
            logger.warn('Action close transition failed', {
              planId: req.params.id,
              actionId: req.params.actionId,
              targetStatus,
              error: (err as Error).message,
            });
          }
        }
        res.json({ ok: true, action: result.action, plan: closedPlan ?? undefined });
        return;
      }

      switch (result.reason) {
        case 'plan_not_found':
          res.status(404).json({ error: 'Plan not found' });
          return;
        case 'action_not_found':
          res.status(404).json({ error: 'Action not found' });
          return;
        case 'plan_closed':
          res.status(410).json({ error: 'Plan already closed', currentStatus: result.currentStatus });
          return;
        case 'duplicate':
          res.status(409).json({
            error: 'Action already performed',
            currentStatus: result.currentStatus,
            previouslyActedBy: result.previouslyActedBy,
            previouslyActedAt: result.previouslyActedAt,
          });
          return;
      }
    } catch (err) {
      logger.error('POST /plans/:id/actions/:actionId failed', {
        planId: req.params.id,
        actionId: req.params.actionId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'Failed to act on plan' });
    }
  },
);

export default router;
