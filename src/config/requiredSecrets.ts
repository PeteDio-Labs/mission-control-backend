/**
 * Required secrets — fail-closed boot validation (SEC.1 / C2).
 *
 * Webhook receivers (alertmanager, github) and Pete Bot's HMAC channel all
 * authenticate per-route with a shared secret. Historically these routes
 * would `logger.warn` and silently accept traffic if the env var was unset,
 * which turned a misconfigured deploy (e.g. dropped sealed-secret) into an
 * open webhook receiver.
 *
 * This helper is called once at startup. If any required secret is missing,
 * `assertRequiredSecrets()` throws `MissingRequiredSecretsError` listing the
 * names; the caller (src/index.ts) logs FATAL and exits non-zero so Kubernetes
 * surfaces the CrashLoopBackOff instead of running with auth disabled.
 *
 * Adding a new required secret:
 *   1. Append a RequiredSecret entry below.
 *   2. If the corresponding route can be feature-flagged off, return false
 *      from `routeMounted` when the flag is unset — otherwise return true.
 */

export interface RequiredSecret {
  env: string;
  reason: string;
  routeMounted: () => boolean;
}

export class MissingRequiredSecretsError extends Error {
  public readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required secrets at boot: ${missing.join(', ')}. ` +
        `Set the corresponding env vars (sealed-secret in mission-control namespace) and redeploy.`,
    );
    this.name = 'MissingRequiredSecretsError';
    this.missing = missing;
  }
}

export const REQUIRED_SECRETS: RequiredSecret[] = [
  {
    env: 'GITHUB_WEBHOOK_SECRET',
    reason: 'verifies HMAC signature on /api/v1/github/webhook (SEC.1 / C2)',
    routeMounted: () => true,
  },
  {
    env: 'ALERTMANAGER_WEBHOOK_TOKEN',
    reason: 'verifies bearer token on /api/v1/alerts/alertmanager (SEC.1 / C2)',
    routeMounted: () => true,
  },
  {
    env: 'PETE_BOT_HMAC_SECRET',
    reason:
      'verifies inbound /api/v1/discord/callback HMAC and signs outbound MC→Pete Bot notify calls',
    routeMounted: () => true,
  },
];

export function assertRequiredSecrets(
  env: NodeJS.ProcessEnv = process.env,
  registry: RequiredSecret[] = REQUIRED_SECRETS,
): void {
  const missing: string[] = [];
  for (const r of registry) {
    if (!r.routeMounted()) continue;
    const value = env[r.env];
    if (value === undefined || value.length === 0) {
      missing.push(`${r.env} (${r.reason})`);
    }
  }
  if (missing.length > 0) {
    throw new MissingRequiredSecretsError(missing);
  }
}
