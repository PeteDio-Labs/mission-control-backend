/**
 * Discord Identity service (PB.4).
 *
 * Resolves Discord user IDs to MC user identifiers via the `discord_identities`
 * table (migration 005). Owns the v2 authz check.
 *
 * Pete Bot is stateless and forwards (discord_user_id, plan_id, action_id) to
 * MC; this module is where MC decides whether the click is allowed.
 *
 * v2 authz model:
 *   - linked_via='manual'         → trust the identity (pre-vetted by admin
 *                                   at link time; only admin can seed the row)
 *   - linked_via='authentik_oauth' → BLOCK in v2 (no real group check wired
 *                                   yet; PB v3 adds Authentik live lookup)
 *
 * v2 has exactly one admin (pedro) with a manually-seeded row. The
 * `requiredGroup` argument is logged but not enforced; the real per-kind
 * group check lands in PB v3 alongside self-serve linking.
 */

import db from '../db/client.js';
import { logger } from '../utils/logger.js';

export interface DiscordIdentity {
  discord_user_id: string;
  mc_user_id: string;
  display_name: string | null;
  linked_via: 'manual' | 'authentik_oauth';
  linked_at: string;
  last_used_at: string | null;
  revoked: boolean;
  revoked_at: string | null;
}

export async function resolveDiscordIdentity(
  discordUserId: string,
): Promise<DiscordIdentity | null> {
  const row = await db.queryOne<DiscordIdentity>(
    `SELECT discord_user_id, mc_user_id, display_name, linked_via,
            linked_at, last_used_at, revoked, revoked_at
     FROM discord_identities
     WHERE discord_user_id = $1 AND revoked = FALSE`,
    [discordUserId],
  );
  if (row) {
    // Bump last_used_at fire-and-forget; lookup latency is the user-facing path
    void db
      .query(`UPDATE discord_identities SET last_used_at = NOW() WHERE discord_user_id = $1`, [discordUserId])
      .catch((err) => logger.warn('last_used_at update failed', { discordUserId, error: (err as Error).message }));
  }
  return row;
}

export async function isUserInGroup(
  mcUserId: string,
  requiredGroup: string,
): Promise<boolean> {
  // v2 authz: gate on linked_via=manual. linked_via=authentik_oauth would
  // need a real Authentik group lookup which is PB v3 work.
  const row = await db.queryOne<{ linked_via: string }>(
    `SELECT linked_via FROM discord_identities
     WHERE mc_user_id = $1 AND revoked = FALSE
     LIMIT 1`,
    [mcUserId],
  );
  if (!row) return false;

  if (row.linked_via === 'manual') {
    // Pre-vetted at link time; admin only seeds trusted rows
    logger.debug('isUserInGroup: trusting manual link', { mcUserId, requiredGroup });
    return true;
  }

  // linked_via === 'authentik_oauth' — needs real group check (v3)
  logger.warn(
    'isUserInGroup: authentik_oauth identity hit v2 stub — blocking. ' +
      'Real Authentik group check lands in PB v3.',
    { mcUserId, requiredGroup },
  );
  return false;
}

export async function linkDiscordIdentity(args: {
  discordUserId: string;
  mcUserId: string;
  displayName?: string;
  linkedVia?: 'manual' | 'authentik_oauth';
}): Promise<DiscordIdentity> {
  const row = await db.queryOne<DiscordIdentity>(
    `INSERT INTO discord_identities (discord_user_id, mc_user_id, display_name, linked_via)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (discord_user_id) DO UPDATE
       SET mc_user_id = EXCLUDED.mc_user_id,
           display_name = EXCLUDED.display_name,
           linked_via = EXCLUDED.linked_via,
           revoked = FALSE,
           revoked_at = NULL,
           linked_at = NOW()
     RETURNING *`,
    [args.discordUserId, args.mcUserId, args.displayName ?? null, args.linkedVia ?? 'manual'],
  );
  if (!row) throw new Error('linkDiscordIdentity: upsert returned no row');
  logger.info('Discord identity linked', {
    discordUserId: args.discordUserId,
    mcUserId: args.mcUserId,
    linkedVia: row.linked_via,
  });
  return row;
}

export async function revokeDiscordIdentity(discordUserId: string): Promise<void> {
  await db.query(
    `UPDATE discord_identities
     SET revoked = TRUE, revoked_at = NOW()
     WHERE discord_user_id = $1`,
    [discordUserId],
  );
  logger.info('Discord identity revoked', { discordUserId });
}

export async function listDiscordIdentities(includeRevoked = false): Promise<DiscordIdentity[]> {
  if (includeRevoked) {
    return db.queryMany<DiscordIdentity>(`SELECT * FROM discord_identities ORDER BY linked_at DESC`);
  }
  return db.queryMany<DiscordIdentity>(
    `SELECT * FROM discord_identities WHERE revoked = FALSE ORDER BY linked_at DESC`,
  );
}
