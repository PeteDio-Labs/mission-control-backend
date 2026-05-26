/**
 * Proxy-auth middleware — verifies the request came through oauth2-proxy
 * by checking a shared HMAC signature.
 *
 * Why this exists (defense-in-depth):
 *   authMiddleware in ./auth.ts trusts X-Forwarded-Email / X-Forwarded-User /
 *   X-Forwarded-Groups unconditionally. In production we assume oauth2-proxy
 *   is the only thing in front and sets those headers. But if a LAN client
 *   ever lands inside the cluster (NetworkPolicy gap, port-forward leak,
 *   K8s service exposure misconfig), they could spoof the headers.
 *
 *   This middleware closes that gap by requiring oauth2-proxy to also send
 *   X-Auth-Proxy-Signature: HMAC-SHA256(secret, email|groups|timestamp) and
 *   X-Auth-Proxy-Timestamp: <unix-seconds>. oauth2-proxy is the only thing
 *   in cluster that knows the shared secret (mounted from a SealedSecret),
 *   so a spoofer can't forge a valid signature.
 *
 * When this runs:
 *   - Mount BEFORE authMiddleware on the /api/v1 router section that already
 *     requires user auth (so the agent-reporter and webhook bypass routes
 *     stay public — they have their own auth models).
 *   - Sets req.proxyAuthVerified = true on success, leaves it undefined on
 *     skip (dev mode) or false on failure.
 *   - authMiddleware in ./auth.ts then refuses to populate req.user from
 *     headers in production unless req.proxyAuthVerified === true.
 *
 * Modes:
 *   - production (NODE_ENV=production): AUTH_PROXY_HMAC_SECRET MUST be set
 *     at boot or the server fails to start (fail-closed). Requests without
 *     a valid signature get 401.
 *   - development: if AUTH_PROXY_HMAC_SECRET is set, verify. If not, skip
 *     (the MOCK_USER_EMAIL path in authMiddleware handles dev workflows).
 *
 * Skew window:
 *   - X-Auth-Proxy-Timestamp must be within +/- 300 seconds of server time.
 *     This prevents replay of a signature captured weeks ago. 5 minutes
 *     handles small clock drift between oauth2-proxy and backend pods.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    proxyAuthVerified?: boolean;
  }
}

const SIG_HEADER = 'x-auth-proxy-signature';
const TS_HEADER = 'x-auth-proxy-timestamp';
const EMAIL_HEADER = 'x-forwarded-email';
const GROUPS_HEADER = 'x-forwarded-groups';

/** Max allowed clock skew between oauth2-proxy and backend (seconds). */
const MAX_SKEW_SECONDS = 300;

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Build the canonical string oauth2-proxy signs. Must match the wrapper that
 * oauth2-proxy uses on the way in. Format: `${email}|${groups}|${timestamp}`.
 *
 * Groups header value is taken verbatim (no normalization) because oauth2-proxy
 * controls its formatting. If the upstream wrapper changes group joining,
 * update this together with that change.
 */
function canonicalString(email: string, groups: string, timestamp: string): string {
  return `${email}|${groups}|${timestamp}`;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify the proxy signature on the request. Returns true if valid, false
 * otherwise. Does not throw — the middleware turns the result into a 401.
 */
export function verifyProxySignature(
  req: Request,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  const sig = headerValue(req, SIG_HEADER);
  const tsRaw = headerValue(req, TS_HEADER);
  const email = headerValue(req, EMAIL_HEADER);
  const groups = headerValue(req, GROUPS_HEADER) ?? '';

  if (!sig) return { valid: false, reason: 'missing_signature' };
  if (!tsRaw) return { valid: false, reason: 'missing_timestamp' };
  if (!email) return { valid: false, reason: 'missing_email' };

  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'bad_timestamp' };
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    return { valid: false, reason: 'timestamp_skew' };
  }

  const expected = createHmac('sha256', secret)
    .update(canonicalString(email, groups, String(ts)))
    .digest('hex');

  if (!constantTimeEqualHex(sig, expected)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

/**
 * Express middleware. Set req.proxyAuthVerified or 401.
 *
 * HMAC verification is OPT-IN via `AUTH_PROXY_HMAC_ENABLED=true`. The
 * rationale for opt-in: the initial production deploy uses oauth2-proxy +
 * NetworkPolicy + ClusterIP as the primary security boundary. The HMAC
 * adds a third belt-and-suspenders layer that needs a signer sidecar to
 * compute + inject the signature header before forwarding to backend.
 * Until that sidecar ships, HMAC stays off so production doesn't 401
 * every request.
 *
 * Modes:
 *   - AUTH_PROXY_HMAC_ENABLED=true + AUTH_PROXY_HMAC_SECRET set →
 *     verify every request. 401 on missing/expired/mismatched.
 *   - AUTH_PROXY_HMAC_ENABLED unset/false →
 *     pass through (proxyAuthVerified left undefined). authMiddleware's
 *     production header trust falls back to network-layer trust
 *     (NetworkPolicy + ClusterIP gate the LAN; oauth2-proxy gates the
 *     edge). When the signer sidecar lands, flip this flag on.
 *   - production + ENABLED=true + missing secret →
 *     boot crashes via assertProxyAuthConfigured(); at request time
 *     this branch is unreachable.
 */
export function proxyAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (process.env.AUTH_PROXY_HMAC_ENABLED !== 'true') {
    // HMAC disabled — skip. authMiddleware (next in chain) will still
    // enforce header presence + the MOCK fallback gate.
    next();
    return;
  }

  const secret = process.env.AUTH_PROXY_HMAC_SECRET;

  if (!secret) {
    // Should be unreachable in production thanks to assertProxyAuthConfigured.
    // In dev with HMAC_ENABLED=true but no secret, fail loudly.
    logger.error('proxyAuth: AUTH_PROXY_HMAC_ENABLED=true but AUTH_PROXY_HMAC_SECRET missing');
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Proxy auth secret not configured',
    });
    return;
  }

  // If no proxy headers are present at all, this is probably an agent/webhook
  // request that bypassed authMiddleware in routes/index.ts — but that path
  // doesn't reach this middleware, so getting here without headers means a
  // user request hit us without going through oauth2-proxy. Reject.
  if (!headerValue(req, EMAIL_HEADER) && !headerValue(req, SIG_HEADER)) {
    res.status(401).json({
      error: 'Unauthenticated',
      message: 'No oauth2-proxy headers — request did not pass through the auth proxy',
    });
    return;
  }

  const result = verifyProxySignature(req, secret);
  if (!result.valid) {
    logger.warn('proxyAuth: signature verification failed', {
      reason: result.reason,
      path: req.path,
      method: req.method,
      sourceIp: req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'],
    });
    res.status(401).json({
      error: 'Unauthenticated',
      message: 'Invalid auth-proxy signature',
    });
    return;
  }

  req.proxyAuthVerified = true;
  next();
}

/**
 * Boot-time check — call from app.ts startup. Throws ONLY if HMAC is
 * opt-in enabled but the secret is missing. The "no-HMAC" mode (initial
 * production deploy with oauth2-proxy + NetworkPolicy only) is a valid
 * configuration and doesn't trip this.
 */
export function assertProxyAuthConfigured(): void {
  if (process.env.AUTH_PROXY_HMAC_ENABLED !== 'true') return;
  if (process.env.NODE_ENV !== 'production') return;
  if (!process.env.AUTH_PROXY_HMAC_SECRET) {
    throw new Error(
      'AUTH_PROXY_HMAC_ENABLED=true but AUTH_PROXY_HMAC_SECRET is missing. ' +
        'Set the secret from oauth2-proxy-secrets, or unset AUTH_PROXY_HMAC_ENABLED ' +
        'if you intended to run without HMAC. Refusing to boot.',
    );
  }
}
