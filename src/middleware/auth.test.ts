/**
 * Auth middleware tests
 *
 * Three execution paths to cover:
 *   1. Headers present (production via oauth2-proxy)
 *   2. Headers absent + MOCK_USER_EMAIL set (dev fallback)
 *   3. Neither → 401
 *
 * Plus requireAdmin behaviour for admin / non-admin / no-user wiring bug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authMiddleware, requireAdmin, ADMIN_GROUP } from './auth';

// Helpers ─────────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    path: '/api/v1/test',
    method: 'GET',
    ...overrides,
  } as Request;
}

function makeRes(): { res: Response; statusSpy: ReturnType<typeof vi.fn>; jsonSpy: ReturnType<typeof vi.fn> } {
  const statusSpy = vi.fn();
  const jsonSpy = vi.fn();
  const res = {
    status: statusSpy.mockReturnValue({ json: jsonSpy }),
    json: jsonSpy,
  } as unknown as Response;
  return { res, statusSpy, jsonSpy };
}

// authMiddleware ──────────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MOCK_USER_EMAIL;
    delete process.env.MOCK_USER_NAME;
    delete process.env.MOCK_USER_GROUPS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('populates req.user from oauth2-proxy headers and calls next()', () => {
    const req = makeReq({
      headers: {
        'x-forwarded-email': 'pedelgadillo@gmail.com',
        'x-forwarded-user': 'pedro',
        'x-forwarded-groups': 'mc-admins,linux-admins',
      },
    });
    const { res, statusSpy } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(statusSpy).not.toHaveBeenCalled();
    expect(req.user).toEqual({
      email: 'pedelgadillo@gmail.com',
      name: 'pedro',
      groups: ['mc-admins', 'linux-admins'],
      isAdmin: true,
    });
  });

  it('sets isAdmin=false when groups header lacks mc-admins', () => {
    const req = makeReq({
      headers: {
        'x-forwarded-email': 'guest@example.com',
        'x-forwarded-user': 'guest',
        'x-forwarded-groups': 'readonly',
      },
    });
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.isAdmin).toBe(false);
    expect(req.user?.groups).toEqual(['readonly']);
  });

  it('falls back to MOCK_USER_EMAIL when no headers are present', () => {
    process.env.MOCK_USER_EMAIL = 'dev@local';
    process.env.MOCK_USER_NAME = 'dev-user';
    // default groups should make this user an admin (so dev workflows work
    // without extra setup). Verified below.
    const req = makeReq();
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({
      email: 'dev@local',
      name: 'dev-user',
      groups: [ADMIN_GROUP],
      isAdmin: true,
    });
  });

  it('honours MOCK_USER_GROUPS override (non-admin dev user)', () => {
    process.env.MOCK_USER_EMAIL = 'limited@local';
    process.env.MOCK_USER_GROUPS = 'readonly,viewer';
    const req = makeReq();
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.isAdmin).toBe(false);
    expect(req.user?.groups).toEqual(['readonly', 'viewer']);
  });

  it('rejects with 401 when no headers and no MOCK_USER_EMAIL', () => {
    const req = makeReq();
    const { res, statusSpy, jsonSpy } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(401);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Unauthenticated' })
    );
    expect(req.user).toBeUndefined();
  });

  it('derives name from email local-part when X-Forwarded-User missing', () => {
    const req = makeReq({
      headers: {
        'x-forwarded-email': 'someone@example.com',
        'x-forwarded-groups': 'mc-admins',
      },
    });
    const { res } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    authMiddleware(req, res, next);

    expect(req.user?.name).toBe('someone');
  });
});

// requireAdmin ────────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  it('calls next() for admin users', () => {
    const req = makeReq();
    req.user = {
      email: 'pedro@example.com',
      name: 'pedro',
      groups: [ADMIN_GROUP],
      isAdmin: true,
    };
    const { res, statusSpy } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin users', () => {
    const req = makeReq();
    req.user = {
      email: 'guest@example.com',
      name: 'guest',
      groups: ['readonly'],
      isAdmin: false,
    };
    const { res, statusSpy, jsonSpy } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(403);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Forbidden' })
    );
  });

  it('returns 500 if req.user is missing (wiring bug guard)', () => {
    const req = makeReq();
    const { res, statusSpy, jsonSpy } = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    requireAdmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusSpy).toHaveBeenCalledWith(500);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Internal Server Error' })
    );
  });
});
