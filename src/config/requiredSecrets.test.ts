import { describe, it, expect } from 'vitest';
import {
  assertRequiredSecrets,
  MissingRequiredSecretsError,
  REQUIRED_SECRETS,
  type RequiredSecret,
} from './requiredSecrets';

const registry: RequiredSecret[] = [
  { env: 'A_SECRET', reason: 'route A', routeMounted: () => true },
  { env: 'B_SECRET', reason: 'route B', routeMounted: () => true },
  { env: 'C_SECRET', reason: 'route C (gated off)', routeMounted: () => false },
];

describe('assertRequiredSecrets', () => {
  it('returns cleanly when every required secret is set', () => {
    expect(() =>
      assertRequiredSecrets({ A_SECRET: 'x', B_SECRET: 'y' }, registry),
    ).not.toThrow();
  });

  it('throws MissingRequiredSecretsError naming each missing secret', () => {
    let err: unknown;
    try {
      assertRequiredSecrets({ B_SECRET: 'y' }, registry);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingRequiredSecretsError);
    const missing = (err as MissingRequiredSecretsError).missing;
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('A_SECRET');
    expect(missing[0]).toContain('route A');
  });

  it('lists every missing secret in one throw, not just the first', () => {
    try {
      assertRequiredSecrets({}, registry);
    } catch (e) {
      const missing = (e as MissingRequiredSecretsError).missing;
      expect(missing).toHaveLength(2);
      expect(missing.some((m) => m.includes('A_SECRET'))).toBe(true);
      expect(missing.some((m) => m.includes('B_SECRET'))).toBe(true);
    }
  });

  it('treats empty string as missing (sealed-secret rotation footgun)', () => {
    expect(() =>
      assertRequiredSecrets({ A_SECRET: '', B_SECRET: 'y' }, registry),
    ).toThrow(MissingRequiredSecretsError);
  });

  it('skips secrets whose routeMounted() returns false', () => {
    // C_SECRET is unset and gated off — must not be reported.
    expect(() =>
      assertRequiredSecrets({ A_SECRET: 'x', B_SECRET: 'y' }, registry),
    ).not.toThrow();
  });

  it('default registry lists the three known critical secrets', () => {
    const names = REQUIRED_SECRETS.map((s) => s.env);
    expect(names).toContain('GITHUB_WEBHOOK_SECRET');
    expect(names).toContain('ALERTMANAGER_WEBHOOK_TOKEN');
    expect(names).toContain('PETE_BOT_HMAC_SECRET');
  });
});
