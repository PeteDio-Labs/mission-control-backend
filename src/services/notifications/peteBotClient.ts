/**
 * Pete Bot v2 HTTP client (RETRO.17 / PB.5 dispatch arm).
 *
 * MC Backend → Pete Bot POST calls. Pete Bot v2 exposes:
 *   POST /v1/notify        — render a fresh Plan as a Discord embed + buttons
 *   POST /v1/edit-message  — edit an existing posted message (state update / strip buttons)
 *
 * HMAC: outbound signs `${timestamp}.${rawBody}` with PETE_BOT_HMAC_SECRET
 * (same shared secret Pete Bot uses to sign inbound /discord/callback).
 * Mirrors the inbound verifier in api/routes/discord.ts so failure modes are
 * symmetric. 5-min replay window matches.
 *
 * Failure mode: every call returns { ok, status, body? } — caller decides
 * whether to retry. We do NOT throw on HTTP errors; the dispatch arm is
 * fire-and-forget and shouldn't break the Plan create path.
 */

import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { PlanRow, PlanActionRow } from '../planStore.js';

const PETE_BOT_URL = process.env.PETE_BOT_URL ?? 'http://pete-bot.mission-control.svc.cluster.local:3015';
const PETE_BOT_HMAC_SECRET = process.env.PETE_BOT_HMAC_SECRET ?? '';
const PETE_BOT_TIMEOUT_MS = parseInt(process.env.PETE_BOT_TIMEOUT_MS ?? '5000', 10);

if (!PETE_BOT_HMAC_SECRET) {
  logger.warn(
    'PETE_BOT_HMAC_SECRET not set — MC→Pete Bot notify calls will be sent without a signature ' +
      'and Pete Bot will reject them. Seal the secret (see SEC.3) or unset PETE_BOT_URL to disable dispatch.',
  );
}

// ─── Payload shapes ─────────────────────────────────────────────────

/** POST /v1/notify payload. Pete Bot is stateless — full plan + actions every time. */
export interface NotifyPayload {
  planId: string;
  kind: string;
  severity: string;
  source: string;
  target: string | null;
  summary: string;
  expiresAt: string | null;
  mcUrl: string;
  /** Action catalog rendered as Discord buttons. */
  actions: Array<{
    actionId: string;
    label: string;
    style: 'primary' | 'secondary' | 'danger' | 'link';
  }>;
  /** If false, Pete Bot renders the embed without any buttons (notification only). */
  buttonsEnabled: boolean;
}

/** POST /v1/edit-message payload — used on state transitions to update Discord. */
export interface EditMessagePayload {
  planId: string;
  /** Pete Bot looks up channelId+messageId from its internal cache keyed by planId. */
  newStatus: string;
  /** If true, Pete Bot strips all buttons (terminal state). */
  stripButtons: boolean;
  /** Optional message text appended below the embed (e.g. "Approved by pedro"). */
  appendText?: string;
}

export interface PeteBotResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

// ─── HMAC sign + POST helper ─────────────────────────────────────────

async function signedPost(path: string, payload: object): Promise<PeteBotResult> {
  if (!PETE_BOT_HMAC_SECRET) {
    return { ok: false, status: 0, error: 'PETE_BOT_HMAC_SECRET not set' };
  }

  const rawBody = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = crypto
    .createHmac('sha256', PETE_BOT_HMAC_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const url = `${PETE_BOT_URL.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PETE_BOT_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pete-bot-signature': `sha256=${signature}`,
        'x-pete-bot-timestamp': timestamp,
      },
      body: rawBody,
      signal: controller.signal,
    });

    let body: unknown = undefined;
    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try { body = await resp.json(); } catch { /* swallow */ }
    } else {
      try { body = await resp.text(); } catch { /* swallow */ }
    }

    if (!resp.ok) {
      logger.warn(`Pete Bot ${path} returned ${resp.status}`, { status: resp.status, body });
      return { ok: false, status: resp.status, body };
    }

    return { ok: true, status: resp.status, body };
  } catch (err) {
    const msg = (err as Error).message;
    if ((err as Error).name === 'AbortError') {
      logger.warn(`Pete Bot ${path} timed out after ${PETE_BOT_TIMEOUT_MS}ms`);
      return { ok: false, status: 0, error: 'timeout' };
    }
    logger.error(`Pete Bot ${path} request failed`, { error: msg });
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/** POST /v1/notify — render a Plan as a Discord embed + buttons. */
export async function postNotify(payload: NotifyPayload): Promise<PeteBotResult> {
  return signedPost('/v1/notify', payload);
}

/** POST /v1/edit-message — update a previously-posted Plan message. */
export async function postEditMessage(payload: EditMessagePayload): Promise<PeteBotResult> {
  return signedPost('/v1/edit-message', payload);
}

// ─── Plan → NotifyPayload mapper ─────────────────────────────────────

/** Build a NotifyPayload from a PlanRow + its actions. */
export function buildNotifyPayload(
  plan: PlanRow,
  actions: PlanActionRow[],
  opts: { buttonsEnabled: boolean; mcPublicUrl: string },
): NotifyPayload {
  return {
    planId: plan.id,
    kind: plan.kind,
    severity: plan.severity,
    source: plan.source,
    target: plan.target,
    summary: plan.summary,
    expiresAt: plan.expires_at,
    mcUrl: `${opts.mcPublicUrl.replace(/\/$/, '')}/plans/${plan.id}`,
    buttonsEnabled: opts.buttonsEnabled,
    actions: actions
      .slice()
      .sort((a, b) => a.ordering - b.ordering)
      .map((a) => ({
        actionId: a.action_id,
        label: a.label,
        style: a.style,
      })),
  };
}
