/**
 * Auth middleware — populates req.user from oauth2-proxy headers.
 *
 * Architecture: in production, oauth2-proxy is the ingress upstream. It
 * authenticates the request against the Authentik `mission-control`
 * provider and forwards three trusted headers downstream:
 *
 *   X-Forwarded-Email   — authenticated principal email
 *   X-Forwarded-User    — authenticated principal username/uid
 *   X-Forwarded-Groups  — comma-separated group names (e.g. "mc-admins,linux-admins")
 *
 * In dev/local mode (no oauth2-proxy in front), an env var fallback lets
 * the backend run standalone:
 *
 *   MOCK_USER_EMAIL    — required to enable the dev fallback (any value)
 *   MOCK_USER_NAME     — optional display name (defaults to email local-part)
 *   MOCK_USER_GROUPS   — optional comma-separated groups (defaults to "mc-admins")
 *
 * Behaviour matrix:
 *
 *   Header present?  MOCK env set?  → Result
 *   ────────────────────────────────────────────────────────────
 *   yes              -              → req.user populated from headers
 *   no               yes            → req.user populated from MOCK envs
 *   no               no             → 401 Unauthorized
 *
 * `requireAdmin` is a follow-up middleware that 403s when
 * `!req.user.isAdmin` (i.e. principal is not in the `mc-admins` group).
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export interface AuthenticatedUser {
  email: string;
  name: string;
  groups: string[];
  isAdmin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

/** The Authentik group whose members get admin (write) access to MC. */
export const ADMIN_GROUP = 'mc-admins';

/** Header names oauth2-proxy sets when --pass-user-headers=true. */
const EMAIL_HEADER = 'x-forwarded-email';
const USER_HEADER = 'x-forwarded-user';
const GROUPS_HEADER = 'x-forwarded-groups';

function parseGroups(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

function userFromHeaders(req: Request): AuthenticatedUser | null {
  const headerValue = (name: string): string | undefined => {
    const v = req.headers[name];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  const email = headerValue(EMAIL_HEADER);
  if (!email) return null;

  const name = headerValue(USER_HEADER) ?? email.split('@')[0] ?? email;
  const groups = parseGroups(headerValue(GROUPS_HEADER));

  return {
    email,
    name,
    groups,
    isAdmin: groups.includes(ADMIN_GROUP),
  };
}

function userFromMockEnv(): AuthenticatedUser | null {
  // SECURITY: Mock auth is dev-only. If this fallback ran in production, anyone
  // who could set MOCK_USER_EMAIL on the backend pod (configmap typo, supply-chain
  // attack on Helm values, accidental env leak) would get auto-admin without
  // touching oauth2-proxy. Wave 1 audit (2026-05-06, finding S3.1) flagged the
  // unguarded version as HIGH severity. NODE_ENV=production is the deploy invariant
  // that prevents this mock from being a backdoor.
  if (process.env.NODE_ENV === 'production') return null;

  const email = process.env.MOCK_USER_EMAIL;
  if (!email) return null;

  const name = process.env.MOCK_USER_NAME ?? email.split('@')[0] ?? email;
  // Default mock user is admin so dev workflows work out-of-the-box. Override
  // with MOCK_USER_GROUPS="" (or any group list excluding mc-admins) to test
  // non-admin paths.
  const groupsRaw = process.env.MOCK_USER_GROUPS ?? ADMIN_GROUP;
  const groups = parseGroups(groupsRaw);

  return {
    email,
    name,
    groups,
    isAdmin: groups.includes(ADMIN_GROUP),
  };
}

/**
 * Express middleware — populates req.user, 401s if no identity is available.
 *
 * Call BEFORE your protected route handlers. In app.ts this should mount
 * after CORS/JSON middleware and before route mounts (or at minimum on the
 * /api/v1 router so health/metrics can stay public).
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const fromHeaders = userFromHeaders(req);
  if (fromHeaders) {
    req.user = fromHeaders;
    next();
    return;
  }

  const fromMock = userFromMockEnv();
  if (fromMock) {
    req.user = fromMock;
    next();
    return;
  }

  logger.warn('Unauthenticated request rejected', {
    path: req.path,
    method: req.method,
    forwardedFor: req.headers['x-forwarded-for'],
  });
  res.status(401).json({
    error: 'Unauthenticated',
    message:
      'No X-Forwarded-Email header from oauth2-proxy and MOCK_USER_EMAIL not set.',
  });
}

/**
 * Express middleware — 403s if the authenticated user is not an admin.
 *
 * Mount AFTER `authMiddleware` on routes that perform mutating operations
 * (POST/PUT/DELETE/PATCH) on agents, runbooks, infra resources, etc.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    // authMiddleware should have run first; this is a wiring bug.
    logger.error('requireAdmin: req.user not set — authMiddleware missing?', {
      path: req.path,
    });
    res
      .status(500)
      .json({ error: 'Internal Server Error', message: 'Auth middleware not wired' });
    return;
  }

  if (!req.user.isAdmin) {
    logger.warn('Non-admin user denied access to admin route', {
      email: req.user.email,
      path: req.path,
      method: req.method,
    });
    res.status(403).json({
      error: 'Forbidden',
      message: `Admin access required (membership in '${ADMIN_GROUP}' group)`,
    });
    return;
  }

  next();
}
