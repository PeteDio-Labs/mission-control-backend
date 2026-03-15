/**
 * Notification Client Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { NotificationClient } from './notification';

vi.mock('axios', () => ({
  default: {
    create: vi.fn(),
  },
}));

// Mock metrics to avoid registry conflicts
vi.mock('../metrics', () => ({
  notificationPublishTotal: { inc: vi.fn() },
  notificationPublishDuration: { startTimer: vi.fn(() => vi.fn()) },
}));

const mockedAxios = axios as any;

describe('NotificationClient', () => {
  let client: NotificationClient;
  let mockHttpClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockHttpClient = {
      get: vi.fn(),
      post: vi.fn(),
    };

    mockedAxios.create = vi.fn().mockReturnValue(mockHttpClient);

    client = new NotificationClient('http://notification-service:3002');
  });

  describe('initialization', () => {
    it('should initialize with provided URL', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://notification-service:3002',
          timeout: 5000,
        })
      );
    });

    it('should use environment variable as fallback', () => {
      process.env.NOTIFICATION_SERVICE_URL = 'http://env-service:3002';

      const client2 = new NotificationClient();
      expect(mockedAxios.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseURL: 'http://env-service:3002',
        })
      );

      delete process.env.NOTIFICATION_SERVICE_URL;
    });

    it('should default to http://notification-service:3002', () => {
      delete process.env.NOTIFICATION_SERVICE_URL;

      const client2 = new NotificationClient();
      expect(mockedAxios.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseURL: 'http://notification-service:3002',
        })
      );
    });
  });

  describe('publishEvent', () => {
    it('should POST event to /api/v1/events', async () => {
      mockHttpClient.post.mockResolvedValueOnce({ data: { id: 'evt-1', status: 'queued' } });

      await client.publishEvent({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'Inventory sync completed: 5 hosts, 20 workloads',
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith('/api/v1/events', {
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'Inventory sync completed: 5 hosts, 20 workloads',
      });
    });

    it('should include optional fields when provided', async () => {
      mockHttpClient.post.mockResolvedValueOnce({ data: { id: 'evt-2', status: 'queued' } });

      await client.publishEvent({
        source: 'argocd',
        type: 'rollout',
        severity: 'info',
        message: 'ArgoCD sync triggered for blog-dev',
        affected_service: 'blog-dev',
        namespace: 'blog',
        metadata: { triggeredBy: 'api' },
      });

      expect(mockHttpClient.post).toHaveBeenCalledWith('/api/v1/events', {
        source: 'argocd',
        type: 'rollout',
        severity: 'info',
        message: 'ArgoCD sync triggered for blog-dev',
        affected_service: 'blog-dev',
        namespace: 'blog',
        metadata: { triggeredBy: 'api' },
      });
    });

    it('should not throw on publish failure (fire-and-forget)', async () => {
      mockHttpClient.post.mockRejectedValueOnce(new Error('Connection refused'));

      // Should not throw
      await expect(
        client.publishEvent({
          source: 'kubernetes',
          type: 'deployment',
          severity: 'info',
          message: 'Test event',
        })
      ).resolves.toBeUndefined();
    });

    it('should increment success metric on successful publish', async () => {
      const { notificationPublishTotal } = await import('../metrics');
      mockHttpClient.post.mockResolvedValueOnce({ data: { id: 'evt-3' } });

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
      mockHttpClient.post.mockRejectedValueOnce(new Error('Timeout'));

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
      mockHttpClient.get.mockResolvedValueOnce({ data: { status: 'ok' } });

      const result = await client.testConnection();
      expect(result).toBe(true);
      expect(mockHttpClient.get).toHaveBeenCalledWith('/health');
    });

    it('should return false on connection failure', async () => {
      mockHttpClient.get.mockRejectedValueOnce(new Error('Connection refused'));

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
