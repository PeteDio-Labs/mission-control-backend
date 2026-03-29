/**
 * Notification Client Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationClient } from './notification';

// Mock metrics to avoid registry conflicts
vi.mock('../metrics', () => ({
  notificationPublishTotal: { inc: vi.fn() },
  notificationPublishDuration: { startTimer: vi.fn(() => vi.fn()) },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('NotificationClient', () => {
  let client: NotificationClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NotificationClient('http://notification-service:3002');
  });

  describe('initialization', () => {
    it('should initialize with provided URL', () => {
      const c = new NotificationClient('http://notification-service:3002');
      expect(c).toBeDefined();
    });

    it('should use environment variable as fallback', () => {
      process.env.NOTIFICATION_SERVICE_URL = 'http://env-service:3002';
      const c = new NotificationClient();
      expect(c).toBeDefined();
      delete process.env.NOTIFICATION_SERVICE_URL;
    });

    it('should default to http://notification-service:3002', () => {
      delete process.env.NOTIFICATION_SERVICE_URL;
      const c = new NotificationClient();
      expect(c).toBeDefined();
    });
  });

  describe('publishEvent', () => {
    it('should POST event to /api/v1/events', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await client.publishEvent({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'Inventory sync completed: 5 hosts, 20 workloads',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://notification-service:3002/api/v1/events',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            source: 'kubernetes',
            type: 'deployment',
            severity: 'info',
            message: 'Inventory sync completed: 5 hosts, 20 workloads',
          }),
        }),
      );
    });

    it('should include optional fields when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await client.publishEvent({
        source: 'argocd',
        type: 'rollout',
        severity: 'info',
        message: 'ArgoCD sync triggered for blog-dev',
        affected_service: 'blog-dev',
        namespace: 'blog',
        metadata: { triggeredBy: 'api' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://notification-service:3002/api/v1/events',
        expect.objectContaining({
          body: JSON.stringify({
            source: 'argocd',
            type: 'rollout',
            severity: 'info',
            message: 'ArgoCD sync triggered for blog-dev',
            affected_service: 'blog-dev',
            namespace: 'blog',
            metadata: { triggeredBy: 'api' },
          }),
        }),
      );
    });

    it('should not throw on publish failure (fire-and-forget)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        client.publishEvent({
          source: 'kubernetes',
          type: 'deployment',
          severity: 'info',
          message: 'Test event',
        }),
      ).resolves.toBeUndefined();
    });

    it('should not throw on non-ok response (fire-and-forget)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await expect(
        client.publishEvent({
          source: 'kubernetes',
          type: 'deployment',
          severity: 'info',
          message: 'Test event',
        }),
      ).resolves.toBeUndefined();
    });

    it('should increment success metric on successful publish', async () => {
      const { notificationPublishTotal } = await import('../metrics');
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      await client.publishEvent({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'Test',
      });

      expect(notificationPublishTotal.inc).toHaveBeenCalledWith({ status: 'success' });
    });

    it('should increment error metric on failed publish', async () => {
      const { notificationPublishTotal } = await import('../metrics');
      mockFetch.mockRejectedValueOnce(new Error('Timeout'));

      await client.publishEvent({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'Test',
      });

      expect(notificationPublishTotal.inc).toHaveBeenCalledWith({ status: 'error' });
    });
  });

  describe('testConnection', () => {
    it('should return true on successful health check', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await client.testConnection();
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://notification-service:3002/health',
        expect.objectContaining({}),
      );
    });

    it('should return false on connection failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.testConnection();
      expect(result).toBe(false);
    });

    it('should return false on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const result = await client.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('isConfigured', () => {
    it('should return true when NOTIFICATION_SERVICE_URL is set', () => {
      process.env.NOTIFICATION_SERVICE_URL = 'http://notification-service:3002';
      expect(NotificationClient.isConfigured()).toBe(true);
      delete process.env.NOTIFICATION_SERVICE_URL;
    });

    it('should return false when NOTIFICATION_SERVICE_URL is not set', () => {
      delete process.env.NOTIFICATION_SERVICE_URL;
      expect(NotificationClient.isConfigured()).toBe(false);
    });
  });
});
