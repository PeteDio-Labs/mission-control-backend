/**
 * Notification router (PB.5 dispatch arm — RETRO.17).
 *
 * Decides which sinks a Plan should fan out to (Discord via Pete Bot, MC bell
 * via SSE) and dispatches the notification. After at least one sink succeeds
 * (or 'none' is the legit decision), transitions the plan pending → presented.
 *
 * Settings consulted (seeded in migration 005):
 *   - routing.by_severity            { info|warn|error|critical: ['mc_bell'|'discord'] }
 *   - discord.buttons_enabled        master kill switch (false = render w/o buttons)
 *   - discord.quiet_hours            { start_local, end_local, timezone, action }
 *   - actions.<kind>.discord_allowed per-kind allowlist for Discord rendering
 *
 * Defaults are baked in below for any setting that's missing.
 *
 * Wired from:
 *   - api/routes/plans.ts POST / (agent-facing create)
 *   - api/routes/plans.ts POST /:id/actions/:actionId (mc_web act) — emits SSE
 *   - alertmanager webhook (PB.13)
 *
 * Fire-and-forget: callers do `notifyPlan(plan, actions).catch(...)` so the
 * HTTP response doesn't block on Discord. If Pete Bot is down the plan still
 * persists; PB.8 expiry sweep handles cleanup.
 */

import { logger } from '../../utils/logger.js';
import { eventBus } from '../../api/routes/events.js';
import { getNotificationSetting } from '../notificationSettings.js';
import { presentPlan, getPlanActions } from '../planStore.js';
import { buildNotifyPayload, postNotify } from './peteBotClient.js';
import type { PlanRow, PlanActionRow, PlanSeverity, PlanKind } from '../planStore.js';

const MC_PUBLIC_URL = process.env.MC_PUBLIC_URL ?? 'https://mc.pdlab.dev';

export type Sink = 'mc_bell' | 'discord';

// ─── Defaults (fallback when notification_settings is empty) ──────────

const DEFAULT_ROUTING: Record<PlanSeverity, Sink[]> = {
  info:     ['mc_bell'],
  warn:     ['mc_bell', 'discord'],
  error:    ['mc_bell', 'discord'],
  critical: ['mc_bell', 'discord'],
};

const DEFAULT_KIND_DISCORD_ALLOWED: Record<PlanKind, boolean> = {
  proposed_fix:     true,
  alert:            true,
  gated_action:     false,
  eval_regression:  true,
  capacity_warning: true,
};

// ─── Quiet-hours helper ────────────────────────────────────────────────
// Settings shape: { start_local: "23:00", end_local: "07:00", timezone: "America/Los_Angeles", action: "route_to_mc_bell" }
// "Local" means in the configured timezone; we compute the current hour:minute
// in that tz via Intl.DateTimeFormat (no extra deps). Wraps midnight cleanly.

interface QuietHoursConfig {
  start_local: string;     // "HH:MM" 24h
  end_local: string;       // "HH:MM" 24h
  timezone: string;        // IANA tz name
  action: 'route_to_mc_bell' | 'suppress' | 'allow'; // what to do during quiet hrs
}

function isInQuietHours(cfg: QuietHoursConfig | null, now = new Date()): boolean {
  if (!cfg) return false;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: cfg.timezone,
    });
    const nowHm = fmt.format(now); // "HH:MM" in target tz
    const startMin = hmToMinutes(cfg.start_local);
    const endMin = hmToMinutes(cfg.end_local);
    const nowMin = hmToMinutes(nowHm);
    if (startMin <= endMin) {
      return nowMin >= startMin && nowMin < endMin;
    }
    // Wraps midnight (e.g., 23:00 → 07:00)
    return nowMin >= startMin || nowMin < endMin;
  } catch (err) {
    logger.warn('Quiet-hours check failed; treating as outside quiet hours', { error: (err as Error).message });
    return false;
  }
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map((n) => parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

// ─── selectSinks ───────────────────────────────────────────────────────

export interface SinkDecision {
  sinks: Sink[];
  buttonsEnabled: boolean;
  reasons: string[]; // for logging — why each sink was kept/dropped
}

export async function selectSinks(plan: PlanRow, now = new Date()): Promise<SinkDecision> {
  const reasons: string[] = [];

  // 1. Severity → base sink set
  const routing = (await getNotificationSetting<Record<PlanSeverity, Sink[]>>('routing.by_severity'))
    ?? DEFAULT_ROUTING;
  const baseSinks: Sink[] = routing[plan.severity] ?? DEFAULT_ROUTING[plan.severity];
  reasons.push(`severity=${plan.severity} → baseSinks=[${baseSinks.join(',')}]`);

  // 2. Per-kind Discord allowlist
  const kindAllowed = (await getNotificationSetting<boolean>(`actions.${plan.kind}.discord_allowed`))
    ?? DEFAULT_KIND_DISCORD_ALLOWED[plan.kind] ?? false;
  let sinks = [...baseSinks];
  if (!kindAllowed && sinks.includes('discord')) {
    sinks = sinks.filter((s) => s !== 'discord');
    reasons.push(`kind=${plan.kind} discord_allowed=false → discord dropped`);
  }

  // 3. Quiet hours (always allows critical through; downgrades others per cfg.action)
  if (sinks.includes('discord') && plan.severity !== 'critical') {
    const quietCfg = await getNotificationSetting<QuietHoursConfig>('discord.quiet_hours');
    if (isInQuietHours(quietCfg, now)) {
      if (quietCfg?.action === 'suppress') {
        sinks = sinks.filter((s) => s !== 'discord');
        reasons.push(`quiet_hours active + action=suppress → discord dropped`);
      } else if (quietCfg?.action === 'route_to_mc_bell') {
        sinks = sinks.filter((s) => s !== 'discord');
        if (!sinks.includes('mc_bell')) sinks.push('mc_bell');
        reasons.push(`quiet_hours active + action=route_to_mc_bell → discord→mc_bell`);
      } else {
        reasons.push(`quiet_hours active + action=allow → no change`);
      }
    }
  }

  // 4. Master button kill switch — keeps discord sink but renders without buttons
  const buttonsEnabled = (await getNotificationSetting<boolean>('discord.buttons_enabled')) ?? true;
  if (!buttonsEnabled) {
    reasons.push(`discord.buttons_enabled=false → notification-only render`);
  }

  return { sinks, buttonsEnabled, reasons };
}

// ─── notifyPlan ────────────────────────────────────────────────────────

export interface NotifyResult {
  planId: string;
  sinks: Sink[];
  buttonsEnabled: boolean;
  reasons: string[];
  results: Partial<Record<Sink, { ok: boolean; detail?: unknown }>>;
  presentedTransitioned: boolean;
}

/**
 * Dispatch a freshly-created Plan to its decided sinks. Call AFTER createPlan.
 * Safe to call repeatedly (idempotent at the planStore.presentPlan layer).
 *
 * The optional `actions` arg avoids a second DB fetch — pass the actions you
 * already have. If omitted, we fetch them.
 */
export async function notifyPlan(
  plan: PlanRow,
  actions?: PlanActionRow[],
): Promise<NotifyResult> {
  const decision = await selectSinks(plan);
  const results: NotifyResult['results'] = {};
  let anySinkSucceeded = false;

  const planActions = actions ?? (await getPlanActions(plan.id));

  for (const sink of decision.sinks) {
    if (sink === 'discord') {
      const payload = buildNotifyPayload(plan, planActions, {
        buttonsEnabled: decision.buttonsEnabled,
        mcPublicUrl: MC_PUBLIC_URL,
      });
      const r = await postNotify(payload);
      results.discord = { ok: r.ok, detail: r.error ?? r.status };
      if (r.ok) anySinkSucceeded = true;
    } else if (sink === 'mc_bell') {
      // MC bell = SSE event on existing /api/v1/events stream. UI bell consumes.
      try {
        eventBus.emit('event', {
          source: 'mission-control',
          type: 'plan.presented',
          severity: plan.severity,
          message: plan.summary,
          metadata: {
            planId: plan.id,
            kind: plan.kind,
            target: plan.target,
            mcUrl: `${MC_PUBLIC_URL.replace(/\/$/, '')}/plans/${plan.id}`,
            actions: planActions.map((a) => ({ actionId: a.action_id, label: a.label, style: a.style })),
          },
          timestamp: new Date().toISOString(),
        });
        results.mc_bell = { ok: true };
        anySinkSucceeded = true;
      } catch (err) {
        results.mc_bell = { ok: false, detail: (err as Error).message };
      }
    }
  }

  // Transition pending → presented if at least one sink fired OR if no sinks
  // were selected (a plan with no notification path is still "presented" by
  // virtue of being persisted; otherwise it'd be stuck in pending forever).
  let presentedTransitioned = false;
  if (anySinkSucceeded || decision.sinks.length === 0) {
    const transitioned = await presentPlan(plan.id);
    presentedTransitioned = transitioned?.status === 'presented';
  }

  logger.info('Plan notify decision', {
    planId: plan.id,
    severity: plan.severity,
    kind: plan.kind,
    sinks: decision.sinks,
    buttonsEnabled: decision.buttonsEnabled,
    reasons: decision.reasons,
    results,
    presentedTransitioned,
  });

  return {
    planId: plan.id,
    sinks: decision.sinks,
    buttonsEnabled: decision.buttonsEnabled,
    reasons: decision.reasons,
    results,
    presentedTransitioned,
  };
}
