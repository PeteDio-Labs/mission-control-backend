/**
 * Tests for the alertmanager bearer-token verifier (SEC.1 / C2).
 *
 * The historical regression we are guarding against: when WEBHOOK_TOKEN was
 * unset, `verifyBearer` returned `true` for ANY request — turning the
 * /alerts/alertmanager endpoint into an unauthenticated webhook receiver.
 * Boot validation now guarantees the token is non-empty, but we still
 * verify the helper rejects unauthed requests when (defensively) passed
 * an empty string.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Stub everything the route module would normally pull in so importing it
// doesn't drag in DB / notification clients.
vi.mock('../../services/planStore', () => ({
  createPlan: vi.fn(),
  transitionStatus: vi.fn(),
  listPlans: vi.fn(),
}));
vi.mock('../../services/notifications/router', () => ({
  notifyPlan: vi.fn(),
}));
vi.mock('../../services/notifications/peteBotClient', () => ({
  postEditMessage: vi.fn(),
}));

import { verifyBearer } from './alertmanager';

describe('alertmanager.verifyBearer', () => {
  const TOKEN = 'super-secret-bearer-token-1234567890';

  it('rejects when no Authorization header is present', () => {
    expect(verifyBearer(undefined, TOKEN)).toBe(false);
  });

  it('rejects an empty Authorization header', () => {
    expect(verifyBearer('', TOKEN)).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(verifyBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });

  it('rejects a wrong bearer value', () => {
    expect(verifyBearer(`Bearer ${TOKEN}WRONG`, TOKEN)).toBe(false);
  });

  it('rejects a token of different length (no timingSafeEqual exception leak)', () => {
    expect(verifyBearer('Bearer short', TOKEN)).toBe(false);
  });

  it('accepts the exact correct bearer token', () => {
    expect(verifyBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('returns false (fail-closed) if the expected token is empty', () => {
    // Boot validator prevents this state in production, but verify the
    // helper itself does NOT silently accept when called with empty token —
    // i.e. the old "open mode" fallthrough is gone.
    expect(verifyBearer(`Bearer ${TOKEN}`, '')).toBe(false);
    expect(verifyBearer(undefined, '')).toBe(false);
  });
});
