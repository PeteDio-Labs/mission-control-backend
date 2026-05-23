/**
 * Notification settings store (PB.5 backing).
 *
 * Reads/writes the `notification_settings` JSONB table seeded in migration 005.
 * Used by:
 *   - the notification router (PB.5) to decide sinks per plan
 *   - the Discord callback (PB.4 in discord.ts) to look up authz groups
 *   - the MC Settings UI (PB.12) to surface + edit settings
 *
 * Reads are cached for 30s to keep the hot path off the DB. Writes invalidate
 * the cache for the touched key.
 */

import db from '../db/client.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export async function getNotificationSetting<T = unknown>(key: string): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  const row = await db.queryOne<{ setting_value: T }>(
    `SELECT setting_value FROM notification_settings WHERE setting_key = $1`,
    [key],
  );
  const value = row?.setting_value ?? null;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function setNotificationSetting(args: {
  key: string;
  value: unknown;
  description?: string;
  updatedBy?: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO notification_settings (setting_key, setting_value, description, updated_by)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value,
           description = COALESCE(EXCLUDED.description, notification_settings.description),
           updated_by = EXCLUDED.updated_by`,
    [args.key, JSON.stringify(args.value), args.description ?? null, args.updatedBy ?? null],
  );
  cache.delete(args.key);
  logger.info('Notification setting updated', { key: args.key, updatedBy: args.updatedBy });
}

export async function listNotificationSettings(prefix?: string): Promise<
  Array<{ setting_key: string; setting_value: unknown; description: string | null; updated_at: string }>
> {
  if (prefix) {
    return db.queryMany(
      `SELECT setting_key, setting_value, description, updated_at
       FROM notification_settings WHERE setting_key LIKE $1 ORDER BY setting_key`,
      [`${prefix}%`],
    );
  }
  return db.queryMany(
    `SELECT setting_key, setting_value, description, updated_at
     FROM notification_settings ORDER BY setting_key`,
  );
}

export function invalidateSettingsCache(): void {
  cache.clear();
}
