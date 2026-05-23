/**
 * Discord Routes — /api/v1/discord
 *
 * Pete Bot v2 click-forward receiver (PB.3 + PB.4).
 *
 * Pete Bot is stateless. When a user clicks a Discord button, Pete Bot's
 * interaction handler extracts (planId, actionId, discord_user_id) from the
 * interaction and POSTs them here with an HMAC signature. MC owns the
 * identity resolution (discord_user_id → mc_user_id via discord_identities),
 * the authz check (Authentik group membership), the idempotency dedupe,
 * and the actual state transition.
 *
 * Routes:
 *   POST /api/v1/discord/callback — Pete Bot click forwarder
 *
 * Auth model: HMAC-SHA256 over the raw request body with shared secret
 * `PETE_BOT_HMAC_SECRET` (sealed-secret in mission-control namespace).
 * No user auth — Pete Bot is the trusted client; the shared secret is the
 * authn boundary.
 *
 * Mounted under apiV1Router BEFORE the global authMiddleware.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { recordClick } from '../../services/planStore.js';
import {
  resolveDiscordIdentity,
  isUserInGroup,
} from '../../services/discordIdentity.js';
import { getNotificationSetting } from '../../services/notificationSettings.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const PETE_BOT_HMAC_SECRET = process.env.PETE_BOT_HMAC_SECRET ?? '';

if (!PETE_BOT_HMAC_SECRET) {
  logger.warn(
    'PETE_BOT_HMAC_SECRET not set — /api/v1/discord/callback will reject all requests. ' +
      'Set the env var or seal a Secret named pete-bot-hmac-secret in mission-control.',
  );
}

// ─── Body schema ─────────────────────────────────────────────────────

const CallbackBodySchema = z.object({
  planId: z.string().regex(/^pl_[a-zA-Z0-9_-]{4,64}$/),
  actionId: z.string().min(1).max(64),
  discordUserId: z.string().regex(/^[0-9]{10,30}$/),
  clickTs: z.string().datetime().optional(),
  channelId: z.string().regex(/^[0-9]{10,30}$/).optional(),
  messageId: z.string().regex(/^[0-9]{10,30}$/).optional(),
});

// ─── HMAC verification ──────────────────────────────────────────────
// Pete Bot signs `${timestamp}.${rawBody}` with the shared secret and sends
// the result as `x-pete-bot-signature: sha256=<hex>` + `x-pete-bot-timestamp: <ts>`.
// 5-minute timestamp window blocks replay.

function verifyHmac(req: Request): { ok: true } | { ok: false; reason: string } {
  if (!PETE_BOT_HMAC_SECRET) return { ok: false, reason: 'server_misconfigured' };

  const sigHeader = req.header('x-pete-bot-signature');
  const tsHeader = req.header('x-pete-bot-timestamp');
  if (!sigHeader || !tsHeader) return { ok: false, reason: 'missing_signature_or_timestamp' };

  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return { ok: false, reason: 'timestamp_out_of_window' };

  // RETRO.13: rawBody is populated by the express.json({verify}) middleware
  // wired in app.ts. Pete Bot signs the literal JSON bytes it sent over the
  // wire — JSON.stringify(req.body) is NOT byte-equivalent (key ordering,
  // whitespace, escaping all differ), so it cannot be used as a fallback.
  // Missing rawBody = the verify callback never fired = server misconfigured.
  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  if (rawBody === undefined) {
    return { ok: false, reason: 'server_misconfigured_rawbody' };
  }
  const expected = crypto
    .createHmac('sha256', PETE_BOT_HMAC_SECRET)
    .update(`${tsHeader}.${rawBody}`)
    .digest('hex');
  const expectedHeader = `sha256=${expected}`;

  // Constant-time compare to avoid timing leaks
  if (sigHeader.length !== expectedHeader.length) return { ok: false, reason: 'bad_signature' };
  const ok = crypto.timingSafeEqual(
    Buffer.from(sigHeader),
    Buffer.from(expectedHeader),
  );
  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ─── POST /discord/callback ─────────────────────────────────────────

router.post('/callback', async (req: Request, res: Response) => {
  // 1. HMAC verify
  const sig = verifyHmac(req);
  if (!sig.ok) {
    logger.warn('Discord callback HMAC rejected', { reason: sig.reason, ip: req.ip });
    res.status(401).json({ error: 'Invalid signature', reason: sig.reason });
    return;
  }

  // 2. Body shape
  const parsed = CallbackBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }
  const { planId, actionId, discordUserId } = parsed.data;

  try {
    // 3. Identity lookup — discord user → MC user
    const identity = await resolveDiscordIdentity(discordUserId);
    if (!identity) {
      logger.info('Discord callback rejected — discord user not linked', { discordUserId, planId, actionId });
      res.status(403).json({
        error: 'discord_not_linked',
        message: 'Your Discord account is not linked to a Mission Control user. Ask an admin to link it.',
      });
      return;
    }

    // 4. Authz — required group per plan kind (from notification_settings)
    //    NB: we need to know the plan kind first to look up the right setting
    //    key. recordClick does the same plan lookup internally; for now, we
    //    fetch the setting based on a default actions.<kind>.required_group
    //    keyed by the kind we look up here. To avoid a second DB hit, we use
    //    a default lookup pattern that the planStore can refine in future.

    // Use a default group; per-kind override would require fetching the plan
    // first which adds a query. Keep simple for v2 — default to linux-admins
    // unless a kind-specific override is set. PB.12 surfaces the editing UI.
    const requiredGroup = (await getNotificationSetting<string>(`actions.default.required_group`)) ?? 'linux-admins';
    const allowed = await isUserInGroup(identity.mc_user_id, requiredGroup);
    if (!allowed) {
      logger.info('Discord callback rejected — user not in required group', {
        mcUserId: identity.mc_user_id,
        requiredGroup,
        planId,
        actionId,
      });
      res.status(403).json({
        error: 'not_authorized',
        message: `You must be a member of '${requiredGroup}' to act on this plan.`,
      });
      return;
    }

    // 5. Idempotency-safe click record (planStore enforces first-click-wins)
    const result = await recordClick({
      planId,
      actionId,
      actorUserId: identity.mc_user_id,
      actorSource: 'discord',
    });

    if (result.ok) {
      res.json({
        ok: true,
        mcUserId: identity.mc_user_id,
        action: { actionId: result.action.action_id, label: result.action.label },
        // Pete Bot uses this to edit the Discord message
        messageEdit: `Approved by ${identity.display_name ?? identity.mc_user_id}`,
        mcUrl: `${process.env.MC_PUBLIC_URL ?? 'https://mc.pdlab.dev'}/plans/${planId}`,
      });
      return;
    }

    switch (result.reason) {
      case 'plan_not_found':
        res.status(404).json({ error: 'plan_not_found' });
        return;
      case 'action_not_found':
        res.status(404).json({ error: 'action_not_found' });
        return;
      case 'plan_closed':
        res.status(410).json({
          error: 'plan_closed',
          currentStatus: result.currentStatus,
          message: `This plan is already ${result.currentStatus}.`,
        });
        return;
      case 'duplicate':
        res.status(409).json({
          error: 'duplicate',
          currentStatus: result.currentStatus,
          previouslyActedBy: result.previouslyActedBy,
          previouslyActedAt: result.previouslyActedAt,
          message: `Already acted by ${result.previouslyActedBy} at ${result.previouslyActedAt}.`,
        });
        return;
    }
  } catch (err) {
    logger.error('Discord callback failed', {
      planId,
      actionId,
      discordUserId,
      error: (err as Error).message,
    });
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
