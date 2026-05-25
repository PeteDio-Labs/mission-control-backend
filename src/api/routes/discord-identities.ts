/**
 * Discord Identities Routes — /api/v1/discord-identities
 *
 * REST surface for the `discord_identities` table (PB.4 backing). Lets MC
 * Settings (PB.12) list, link, and revoke Discord ↔ MC identity rows
 * without dropping into SQL.
 *
 * The link endpoint accepts the 18-digit Discord snowflake; we validate
 * format up front so the table never grows garbage rows. Mounted under
 * authMiddleware; mutating routes require admin.
 *
 *   GET    /api/v1/discord-identities                — list active links
 *   POST   /api/v1/discord-identities                — link new identity (admin)
 *   DELETE /api/v1/discord-identities/:discord_user_id — revoke (admin)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  linkDiscordIdentity,
  revokeDiscordIdentity,
  listDiscordIdentities,
  resolveDiscordIdentity,
} from '../../services/discordIdentity.js';
import { logger } from '../../utils/logger.js';
import { requireAdmin } from '../../middleware/auth.js';

const router = Router();

// ─── Schemas ─────────────────────────────────────────────────────────

const DiscordIdRegex = /^[0-9]{10,30}$/;

const ListQuerySchema = z.object({
  includeRevoked: z.coerce.boolean().optional(),
});

const LinkBodySchema = z.object({
  discord_user_id: z.string().regex(DiscordIdRegex, 'Discord ID must be 10–30 digits'),
  mc_user_id: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200).optional(),
  linked_via: z.enum(['manual', 'authentik_oauth']).optional(),
});

// ─── GET /discord-identities ─────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params', details: parsed.error.issues });
    return;
  }

  try {
    const identities = await listDiscordIdentities(parsed.data.includeRevoked ?? false);
    res.json({ identities });
  } catch (err) {
    logger.error('GET /discord-identities failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list Discord identities' });
  }
});

// ─── POST /discord-identities — link (admin only) ────────────────────

router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const parsed = LinkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }

  try {
    const identity = await linkDiscordIdentity({
      discordUserId: parsed.data.discord_user_id,
      mcUserId: parsed.data.mc_user_id,
      displayName: parsed.data.display_name,
      linkedVia: parsed.data.linked_via,
    });
    res.status(201).json({ identity });
  } catch (err) {
    logger.error('POST /discord-identities failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to link Discord identity' });
  }
});

// ─── DELETE /discord-identities/:discord_user_id (admin only) ────────

router.delete('/:discord_user_id', requireAdmin, async (req: Request, res: Response) => {
  const discordUserId = req.params.discord_user_id;
  if (!discordUserId || !DiscordIdRegex.test(discordUserId)) {
    res.status(400).json({ error: 'Invalid Discord user id (must be 10–30 digits)' });
    return;
  }

  try {
    // resolveDiscordIdentity returns rows where revoked=FALSE; if it's null
    // we either don't know this id or already revoked it. Surface 404 so
    // the UI can refresh and stop offering Revoke on a stale row.
    const existing = await resolveDiscordIdentity(discordUserId);
    if (!existing) {
      res.status(404).json({ error: 'Discord identity not found or already revoked' });
      return;
    }
    await revokeDiscordIdentity(discordUserId);
    res.json({ revoked: true, discord_user_id: discordUserId });
  } catch (err) {
    logger.error('DELETE /discord-identities/:id failed', {
      discordUserId,
      error: (err as Error).message,
    });
    res.status(500).json({ error: 'Failed to revoke Discord identity' });
  }
});

export default router;
