/**
 * Tests for the GitHub webhook HMAC verifier (SEC.1 / C2).
 *
 * The historical regression we are guarding against: when GITHUB_WEBHOOK_SECRET
 * was unset, the route fell through and accepted ANY payload. Boot validation
 * now guarantees the secret is non-empty, but we still verify the helper
 * rejects when (defensively) passed an empty secret.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'crypto';

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../services/agentStore', () => ({
  insertRun: vi.fn(),
}));
vi.mock('../../services/agentDispatcher', () => ({
  dispatchToAgent: vi.fn(),
}));

import { verifySignature } from './github';

const SECRET = 'webhook-signing-secret-1234567890';
const PAYLOAD = '{"action":"opened","number":42}';

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('github.verifySignature', () => {
  it('rejects when no signature header is provided', () => {
    expect(verifySignature(PAYLOAD, undefined, SECRET)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(verifySignature(PAYLOAD, '', SECRET)).toBe(false);
  });

  it('rejects a signature with the wrong digest', () => {
    expect(
      verifySignature(PAYLOAD, sign(PAYLOAD, 'wrong-secret'), SECRET),
    ).toBe(false);
  });

  it('rejects a signature whose payload has been tampered with', () => {
    const sig = sign(PAYLOAD, SECRET);
    const tampered = PAYLOAD.replace('"opened"', '"closed"');
    expect(verifySignature(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects a signature of different length (no timingSafeEqual exception leak)', () => {
    expect(verifySignature(PAYLOAD, 'sha256=short', SECRET)).toBe(false);
  });

  it('accepts a correctly-signed payload', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('returns false (fail-closed) if the secret is empty', () => {
    // Boot validator prevents this state in production, but verify the
    // helper itself does NOT silently accept when called with empty secret —
    // i.e. the old "no secret → accept without verification" fallthrough is gone.
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), '')).toBe(false);
  });
});
