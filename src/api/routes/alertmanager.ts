/**
 * Alertmanager Webhook — POST /api/v1/alerts/alertmanager  (PB.13)
 *
 * Receives Prometheus Alertmanager v4 webhook payloads and translates each
 * alert into a Plan (kind=alert) on the PB v2 surface. Firing alerts create
 * plans with Acknowledge / Snooze 1h buttons. Resolved alerts auto-close any
 * matching open plan and ask Pete Bot to strip buttons + append a resolution
 * note.
 *
 * Auth model:
 *   - Mounted BEFORE the global authMiddleware (sibling to /github/webhook)
 *     because Alertmanager is an external sender that doesn't have a user.
 *   - Requires `Authorization: Bearer ${ALERTMANAGER_WEBHOOK_TOKEN}`
 *     (constant-time compare). Presence of the env var is guaranteed by the
 *     boot validator in `src/config/requiredSecrets.ts` (SEC.1 / C2) — a
 *     missing value crashes the pod at startup rather than accepting unauthed
 *     traffic.
 *
 * Idempotency:
 *   - Each Alertmanager alert has a stable `fingerprint`. Before creating a
 *     new plan we check listPlans({source:'alertmanager', kind:'alert'}) for
 *     an active plan whose sourceMetadata.fingerprint matches. If found, we
 *     skip (Alertmanager re-fires while we have an open plan are no-ops).
 *
 * Resolved alerts:
 *   - Look up the matching open plan by fingerprint and transition to
 *     'resolved' (actorSource='system'), then ask Pete Bot to edit the
 *     Discord message: strip buttons + append "✅ Resolved at <ts>".
 *
 * Response shape:
 *   { ok: true, processed: N, created: N, resolved: N, skipped: N }
 */

import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import {
  createPlan,
  transitionStatus,
  listPlans,
  type PlanRow,
  type PlanSeverity,
} from '../../services/planStore.js';
import { notifyPlan } from '../../services/notifications/router.js';
import { postEditMessage } from '../../services/notifications/peteBotClient.js';

const router = Router();

// Boot validator (src/config/requiredSecrets.ts) guarantees this is set.
const WEBHOOK_TOKEN = process.env.ALERTMANAGER_WEBHOOK_TOKEN ?? '';
const DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Zod schema for Alertmanager v4 payload ──────────────────────────

const AlertSchema = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().min(1),
});

const AlertmanagerWebhookSchema = z.object({
  version: z.string().optional(),
  groupKey: z.string().optional(),
  status: z.enum(['firing', 'resolved']).optional(),
  receiver: z.string().optional(),
  groupLabels: z.record(z.string()).optional(),
  commonLabels: z.record(z.string()).optional(),
  commonAnnotations: z.record(z.string()).optional(),
  externalURL: z.string().optional(),
  alerts: z.array(AlertSchema).min(1),
});

type AlertmanagerAlert = z.infer<typeof AlertSchema>;

// ─── Auth helper ─────────────────────────────────────────────────────

export function verifyBearer(
  authHeader: string | undefined,
  expectedToken: string = WEBHOOK_TOKEN,
): boolean {
  if (!expectedToken) return false;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice('Bearer '.length).trim();
  // constant-time compare; Buffer.from on mismatched lengths still throws,
  // so guard length first to avoid leaking via exception path.
  if (provided.length !== expectedToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expectedToken));
  } catch {
    return false;
  }
}

// ─── Severity mapping ────────────────────────────────────────────────
// Alertmanager severity label → Plan severity.
//   critical → critical
//   warning  → warn
//   info     → info
//   anything else (or missing) → error (still gets attention)

function mapSeverity(label: string | undefined): PlanSeverity {
  switch ((label ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'info':
    case 'informational':
      return 'info';
    case '':
      return 'info';
    default:
      return 'error';
  }
}

// ─── Find active plan by fingerprint ─────────────────────────────────
// "Active" = not in a terminal closed state.

const ACTIVE_STATUSES = new Set([
  'pending', 'presented', 'clicked', 'dispatched', 'in_progress', 'stuck',
]);

async function findOpenPlanByFingerprint(fingerprint: string): Promise<PlanRow | null> {
  // listPlans defaults to created_at DESC; cap at 500 to keep this cheap.
  // Fingerprints are unique-per-alert, so at most one active plan will match.
  const plans = await listPlans({
    source: 'alertmanager',
    kind: 'alert',
    limit: 500,
  });
  for (const p of plans) {
    if (!ACTIVE_STATUSES.has(p.status)) continue;
    const fp = (p.source_metadata as Record<string, unknown> | null)?.fingerprint;
    if (fp === fingerprint) return p;
  }
  return null;
}

// ─── Handlers ────────────────────────────────────────────────────────

async function handleFiring(alert: AlertmanagerAlert): Promise<'created' | 'skipped'> {
  // RETRO.27 — dual-layer dedupe:
  //   (1) JS-side fast path below: avoids an INSERT attempt when we already
  //       know there's an active plan for this fingerprint.
  //   (2) DB-side safety net (catch 23505 below): closes the TOCTOU race
  //       window between this check and the INSERT, where two concurrent
  //       webhooks for the same fingerprint can both see "no match" and
  //       both call createPlan. The partial unique index installed by
  //       migration 006 makes the second INSERT fail with unique_violation
  //       which we treat as a skip.
  const existing = await findOpenPlanByFingerprint(alert.fingerprint);
  if (existing) {
    logger.info('Alertmanager firing: open plan already exists, skipping', {
      fingerprint: alert.fingerprint,
      planId: existing.id,
      currentStatus: existing.status,
    });
    return 'skipped';
  }

  const severity = mapSeverity(alert.labels.severity);
  const target =
    alert.labels.service ||
    alert.labels.instance ||
    alert.labels.job ||
    alert.labels.alertname ||
    null;
  const summary =
    alert.annotations.summary ||
    alert.annotations.description ||
    alert.labels.alertname ||
    'Alertmanager alert';

  let plan;
  try {
    plan = await createPlan({
      kind: 'alert',
      severity,
      source: 'alertmanager',
      sourceMetadata: {
        fingerprint: alert.fingerprint,
        labels: alert.labels,
        annotations: alert.annotations,
        startsAt: alert.startsAt,
        generatorURL: alert.generatorURL ?? null,
      },
      target: target ?? undefined,
      summary,
      actions: [
        { actionId: 'ack', label: 'Acknowledge', style: 'primary' },
        { actionId: 'snooze_1h', label: 'Snooze 1h', style: 'secondary' },
      ],
      expiresAt: new Date(Date.now() + DEFAULT_EXPIRES_MS),
    });
  } catch (err) {
    // RETRO.27 — DB-side dedupe: the partial unique index
    // idx_plans_alertmanager_fingerprint_open (migration 006) raises
    // Postgres 23505 unique_violation when a concurrent webhook beat us
    // to the INSERT. Treat as a skip — the other call already created
    // the plan and fired the notification.
    if ((err as { code?: string }).code === '23505') {
      logger.info('Alertmanager firing: deduped by DB unique index (concurrent webhook)', {
        fingerprint: alert.fingerprint,
      });
      return 'skipped';
    }
    throw err;
  }

  // RETRO.17: fire-and-forget notify (same pattern as plans.ts POST /)
  notifyPlan(plan).catch((err) => {
    logger.error('notifyPlan failed (fire-and-forget) for alertmanager plan', {
      planId: plan.id,
      fingerprint: alert.fingerprint,
      error: (err as Error).message,
    });
  });

  logger.info('Alertmanager firing: created plan', {
    planId: plan.id,
    fingerprint: alert.fingerprint,
    severity,
    target,
  });
  return 'created';
}

async function handleResolved(alert: AlertmanagerAlert): Promise<'resolved' | 'skipped'> {
  const open = await findOpenPlanByFingerprint(alert.fingerprint);
  if (!open) {
    logger.info('Alertmanager resolved: no open plan for fingerprint, skipping', {
      fingerprint: alert.fingerprint,
    });
    return 'skipped';
  }

  const transitioned = await transitionStatus({
    planId: open.id,
    toStatus: 'resolved',
    actorSource: 'system',
    payload: {
      result: {
        resolvedByAlertmanager: true,
        endsAt: alert.endsAt ?? null,
      },
    },
  });

  if (!transitioned || transitioned.status !== 'resolved') {
    // transitionStatus returns the row unchanged when the transition is
    // invalid; treat that as a soft skip (e.g. plan was already resolved
    // via MC Web before the resolved-webhook arrived).
    logger.warn('Alertmanager resolved: transition did not land', {
      planId: open.id,
      currentStatus: transitioned?.status ?? null,
    });
    return 'skipped';
  }

  // Best-effort: ask Pete Bot to strip buttons + append resolution note.
  // Fire-and-forget — Pete Bot may not have a cached message id (e.g. plan
  // was never posted to Discord because severity routed to mc_bell only).
  const ts = alert.endsAt ?? new Date().toISOString();
  postEditMessage({
    planId: open.id,
    newStatus: 'resolved',
    stripButtons: true,
    appendText: `Resolved at ${ts}`,
  }).catch((err) => {
    logger.warn('postEditMessage failed after alertmanager resolve', {
      planId: open.id,
      error: (err as Error).message,
    });
  });

  logger.info('Alertmanager resolved: closed plan', {
    planId: open.id,
    fingerprint: alert.fingerprint,
  });
  return 'resolved';
}

// ─── Route ───────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  if (!verifyBearer(req.headers.authorization)) {
    logger.warn('Alertmanager webhook: invalid or missing bearer token');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = AlertmanagerWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid alertmanager payload',
      details: parsed.error.issues,
    });
    return;
  }

  const { alerts } = parsed.data;
  let created = 0;
  let resolved = 0;
  let skipped = 0;
  const errors: Array<{ fingerprint: string; error: string }> = [];

  for (const alert of alerts) {
    try {
      if (alert.status === 'firing') {
        const r = await handleFiring(alert);
        if (r === 'created') created += 1;
        else skipped += 1;
      } else {
        const r = await handleResolved(alert);
        if (r === 'resolved') resolved += 1;
        else skipped += 1;
      }
    } catch (err) {
      const msg = (err as Error).message;
      errors.push({ fingerprint: alert.fingerprint, error: msg });
      logger.error('Alertmanager alert handler failed', {
        fingerprint: alert.fingerprint,
        status: alert.status,
        error: msg,
      });
    }
  }

  const status = errors.length > 0 && created + resolved === 0 ? 500 : 200;
  res.status(status).json({
    ok: errors.length === 0,
    processed: alerts.length,
    created,
    resolved,
    skipped,
    ...(errors.length > 0 ? { errors } : {}),
  });
});

export default router;
