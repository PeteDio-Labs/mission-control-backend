/**
 * Tests for the proxyAuth HMAC verification middleware.
 *
 * Coverage:
 *   - Valid signature → req.proxyAuthVerified = true, next() called
 *   - Missing signature → 401
 *   - Missing timestamp → 401
 *   - Missing email → 401
 *   - Expired timestamp (> 300s skew) → 401
 *   - Signature mismatch → 401
 *   - Missing secret in prod → 500
 *   - Missing secret in dev → pass-through (no req.proxyAuthVerified set)
 *   - assertProxyAuthConfigured throws in prod without secret, no-op in dev
 *
 * Constant-time compare safety isn't unit-testable directly; we rely on
 * timingSafeEqual from node:crypto.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  proxyAuthMiddleware,
  verifyProxySignature,
  assertProxyAuthConfigured,
} from './proxyAuth';

const SECRET = 'a'.repeat(64); // 32-byte hex secret

function signRequest(args: {
  email: string;
  groups?: string;
  timestamp?: number;
  secret?: string;
}): {
  signature: string;
  timestamp: string;
  email: string;
  groups: string;
} {
  const ts = args.timestamp ?? Math.floor(Date.now() / 1000);
  const email = args.email;
  const groups = args.groups ?? 'mc-admins';
  const sig = createHmac('sha256', args.secret ?? SECRET)
    .update(`${email}|${groups}|${ts}`)
    .digest('hex');
  return { signature: sig, timestamp: String(ts), email, groups };
}

function mockReq(headers: Record<string, string> = {}): Request {
  return {
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    path: '/api/v1/test',
    method: 'GET',
  } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    res: { status, json } as unknown as Response,
    status,
    json,
  };
}

describe('verifyProxySignature', () => {
  it('accepts a valid signature with current timestamp', () => {
    const { signature, timestamp, email, groups } = signRequest({ email: 'pedro@example.com' });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
      'X-Forwarded-Groups': groups,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: true });
  });

  it('rejects missing signature', () => {
    const { timestamp, email } = signRequest({ email: 'pedro@example.com' });
    const req = mockReq({
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('rejects missing timestamp', () => {
    const { signature, email } = signRequest({ email: 'pedro@example.com' });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Forwarded-Email': email,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'missing_timestamp' });
  });

  it('rejects missing email', () => {
    const { signature, timestamp } = signRequest({ email: 'pedro@example.com' });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'missing_email' });
  });

  it('rejects malformed timestamp', () => {
    const req = mockReq({
      'X-Auth-Proxy-Signature': 'a'.repeat(64),
      'X-Auth-Proxy-Timestamp': 'not-a-number',
      'X-Forwarded-Email': 'pedro@example.com',
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'bad_timestamp' });
  });

  it('rejects timestamp older than 5 minutes', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const { signature, timestamp, email, groups } = signRequest({ email: 'pedro@example.com', timestamp: oldTs });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
      'X-Forwarded-Groups': groups,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'timestamp_skew' });
  });

  it('rejects timestamp from the future beyond skew', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 600;
    const { signature, timestamp, email, groups } = signRequest({ email: 'pedro@example.com', timestamp: futureTs });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
      'X-Forwarded-Groups': groups,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'timestamp_skew' });
  });

  it('rejects signature signed with a different secret', () => {
    const { signature, timestamp, email, groups } = signRequest({
      email: 'pedro@example.com',
      secret: 'b'.repeat(64),
    });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
      'X-Forwarded-Groups': groups,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects signature for tampered email', () => {
    const { signature, timestamp, groups } = signRequest({ email: 'pedro@example.com' });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': 'evil@example.com', // tampered
      'X-Forwarded-Groups': groups,
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects signature for tampered groups', () => {
    const { signature, timestamp, email } = signRequest({ email: 'pedro@example.com', groups: 'mc-admins' });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
      'X-Forwarded-Groups': 'mc-admins,super-admins', // tampered
    });
    expect(verifyProxySignature(req, SECRET)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });
});

describe('proxyAuthMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('sets req.proxyAuthVerified=true on valid signature', () => {
    process.env.AUTH_PROXY_HMAC_SECRET = SECRET;
    const { signature, timestamp, email, groups } = signRequest({ email: 'pedro@example.com' });
    const req = mockReq({
      'X-Auth-Proxy-Signature': signature,
      'X-Auth-Proxy-Timestamp': timestamp,
      'X-Forwarded-Email': email,
      'X-Forwarded-Groups': groups,
    });
    const { res, status } = mockRes();
    const next = vi.fn();

    proxyAuthMiddleware(req, res, next as NextFunction);

    expect(req.proxyAuthVerified).toBe(true);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('401 on invalid signature', () => {
    process.env.AUTH_PROXY_HMAC_SECRET = SECRET;
    const req = mockReq({
      'X-Auth-Proxy-Signature': 'deadbeef'.repeat(8),
      'X-Auth-Proxy-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Forwarded-Email': 'pedro@example.com',
      'X-Forwarded-Groups': 'mc-admins',
    });
    const { res, status, json } = mockRes();
    const next = vi.fn();

    proxyAuthMiddleware(req, res, next as NextFunction);

    expect(req.proxyAuthVerified).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthenticated' }));
  });

  it('401 when no proxy headers and secret is configured', () => {
    process.env.AUTH_PROXY_HMAC_SECRET = SECRET;
    const req = mockReq({});
    const { res, status } = mockRes();
    const next = vi.fn();

    proxyAuthMiddleware(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('passes through when secret is unset in dev', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_PROXY_HMAC_SECRET;
    const req = mockReq({
      'X-Forwarded-Email': 'pedro@example.com',
    });
    const { res, status } = mockRes();
    const next = vi.fn();

    proxyAuthMiddleware(req, res, next as NextFunction);

    expect(req.proxyAuthVerified).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('500 when secret is unset in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_PROXY_HMAC_SECRET;
    const req = mockReq({});
    const { res, status, json } = mockRes();
    const next = vi.fn();

    proxyAuthMiddleware(req, res, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Proxy auth secret not configured' }),
    );
  });
});

describe('assertProxyAuthConfigured', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when production without secret', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTH_PROXY_HMAC_SECRET;
    expect(() => assertProxyAuthConfigured()).toThrow(/AUTH_PROXY_HMAC_SECRET/);
  });

  it('does not throw when production with secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROXY_HMAC_SECRET = SECRET;
    expect(() => assertProxyAuthConfigured()).not.toThrow();
  });

  it('does not throw in development (secret optional)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_PROXY_HMAC_SECRET;
    expect(() => assertProxyAuthConfigured()).not.toThrow();
  });

  it('does not throw in test env', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AUTH_PROXY_HMAC_SECRET;
    expect(() => assertProxyAuthConfigured()).not.toThrow();
  });
});
