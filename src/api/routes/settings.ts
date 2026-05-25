/**
 * Settings Routes — /api/v1/settings
 *
 * REST surface for `notification_settings` JSONB rows (PB.5 backing table).
 * Used by the MC Settings UI (PB.12) so admins can edit the notification
 * routing matrix, Discord button policy, per-action authz and similar
 * config without dropping into SQL.
 *
 * Mounted UNDER apiV1Router.use(authMiddleware) since the settings table
 * holds operational policy — even read access is admin-tier (we don't want
 * unauthenticated callers fingerprinting our auth groups).
 *
 *   GET   /api/v1/settings?prefix=     — list settings, optional key-prefix filter
 *   GET   /api/v1/settings/:key        — single setting; 404 if absent
 *   PATCH /api/v1/settings/:key        — upsert value (+ optional description) — admin only
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getNotificationSetting,
  setNotificationSetting,
  listNotificationSettings,
} from '../../services/notificationSettings.js';
import { logger } from '../../utils/logger.js';
import { requireAdmin } from '../../middleware/auth.js';

const router = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  prefix: z.string().min(1).max(200).optional(),
});

const PatchBodySchema = z.object({
  // JSONB column accepts arbitrary JSON; we only require the key be present.
  // Null is a valid stored value (some flags use null sentinel), so don't
  // coerce undefined→null here.
  value: z.unknown(),
  description: z.string().max(2000).optional(),
});

// ─── GET /settings ───────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params', details: parsed.error.issues });
    return;
  }

  try {
    const settings = await listNotificationSettings(parsed.data.prefix);
    res.json({ settings });
  } catch (err) {
    logger.error('GET /settings failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list settings' });
  }
});

// ─── GET /settings/:key ──────────────────────────────────────────────

router.get('/:key', async (req: Request, res: Response) => {
  const key = req.params.key;
  if (!key) {
    res.status(400).json({ error: 'Missing setting key' });
    return;
  }

  try {
    const value = await getNotificationSetting<unknown>(key);
    if (value === null) {
      res.status(404).json({ error: 'Setting not found', setting_key: key });
      return;
    }
    res.json({ setting_key: key, setting_value: value });
  } catch (err) {
    logger.error('GET /settings/:key failed', { key, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch setting' });
  }
});

// ─── PATCH /settings/:key (admin only) ───────────────────────────────

router.patch('/:key', requireAdmin, async (req: Request, res: Response) => {
  const key = req.params.key;
  if (!key) {
    res.status(400).json({ error: 'Missing setting key' });
    return;
  }

  const parsed = PatchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
    return;
  }

  try {
    await setNotificationSetting({
      key,
      value: parsed.data.value,
      description: parsed.data.description,
      updatedBy: req.user?.email,
    });
    res.json({
      setting_key: key,
      setting_value: parsed.data.value,
      updated_by: req.user?.email ?? null,
    });
  } catch (err) {
    logger.error('PATCH /settings/:key failed', { key, error: (err as Error).message });
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

export default router;
