/**
 * ArgoCD Connector Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArgoCDConnector } from './argocd';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okJson(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(''),
  });
}

function errorResponse(status: number, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ message }),
    text: () => Promise.resolve(JSON.stringify({ message })),
  });
}

describe('ArgoCDConnector', () => {
  let connector: ArgoCDConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new ArgoCDConnector('https://argocd.example.com', 'test-token-123', true);
  });

  describe('initialization', () => {
    it('should initialize with provided server and token', () => {
      expect(connector).toBeDefined();
    });

    it('should add http:// prefix if missing', () => {
      const c = new ArgoCDConnector('argocd.example.com', 'token', true);
      expect(c).toBeDefined();
    });

    it('should use environment variables as fallback', () => {
      process.env.ARGOCD_SERVER = 'https://env-server.com';
      process.env.ARGOCD_AUTH_TOKEN = 'env-token';
      const c = new ArgoCDConnector();
      expect(c).toBeDefined();
      delete process.env.ARGOCD_SERVER;
      delete process.env.ARGOCD_AUTH_TOKEN;
    });
  });

  describe('testConnection', () => {
    it('should return true on successful connection', async () => {
      mockFetch.mockReturnValueOnce(okJson({ version: '2.5.0' }));

      const result = await connector.testConnection();
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://argocd.example.com/api/version',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-token-123' }),
        }),
      );
    });

    it('should return false on connection failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await connector.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('getApplications', () => {
    it('should retrieve all applications', async () => {
      const mockApps = [
        {
          metadata: { name: 'app1', namespace: 'argocd' },
          spec: { project: 'default' },
          status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } },
        },
        {
          metadata: { name: 'app2', namespace: 'argocd' },
          spec: { project: 'default' },
          status: { sync: { status: 'OutOfSync' }, health: { status: 'Degraded' } },
        },
      ];

      mockFetch.mockReturnValueOnce(okJson({ items: mockApps }));

      const result = await connector.getApplications();
      expect(result).toEqual(mockApps);
      expect(result.length).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://argocd.example.com/api/v1/applications',
        expect.anything(),
      );
    });

    it('should return empty array if no items', async () => {
      mockFetch.mockReturnValueOnce(okJson({}));

      const result = await connector.getApplications();
      expect(result).toEqual([]);
    });

    it('should throw on API error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('API Error'));

      await expect(connector.getApplications()).rejects.toThrow('API Error');
    });
  });

  describe('getAppStatus', () => {
    it('should retrieve detailed app status', async () => {
      const mockApp = {
        metadata: { name: 'test-app', namespace: 'argocd' },
        spec: { project: 'default' },
        status: {
          sync: { status: 'Synced', revision: 'abc123' },
          health: { status: 'Healthy', message: 'All good' },
          resources: [
            {
              kind: 'Deployment',
              name: 'my-deployment',
              namespace: 'default',
              status: 'Synced',
              health: { status: 'Healthy' },
            },
          ],
        },
      };

      mockFetch.mockReturnValueOnce(okJson(mockApp));

      const result = await connector.getAppStatus('test-app');
      expect(result).toEqual({
        name: 'test-app',
        namespace: 'argocd',
        syncStatus: 'Synced',
        healthStatus: 'Healthy',
        revision: 'abc123',
        message: 'All good',
        resources: [
          {
            kind: 'Deployment',
            name: 'my-deployment',
            namespace: 'default',
            status: 'Synced',
            health: 'Healthy',
          },
        ],
      });
    });

    it('should handle missing status fields', async () => {
      const mockApp = {
        metadata: { name: 'test-app' },
        spec: { project: 'default' },
      };

      mockFetch.mockReturnValueOnce(okJson(mockApp));

      const result = await connector.getAppStatus('test-app');
      expect(result.syncStatus).toBe('Unknown');
      expect(result.healthStatus).toBe('Unknown');
      expect(result.revision).toBeUndefined();
    });
  });

  describe('syncApp', () => {
    it('should trigger sync successfully', async () => {
      mockFetch.mockReturnValueOnce(okJson({ status: 'Running' }));

      const result = await connector.syncApp('test-app');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Sync operation');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://argocd.example.com/api/v1/applications/test-app/sync',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should support prune and dryRun options', async () => {
      mockFetch.mockReturnValueOnce(okJson({ status: 'Running' }));

      const result = await connector.syncApp('test-app', true, true);
      expect(result.success).toBe(true);
      expect(result.message).toContain('(dry-run)');
    });

    it('should return error on sync failure', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(404, 'App not found'));

      const result = await connector.syncApp('test-app');
      expect(result.success).toBe(false);
      expect(result.error).toBe('App not found');
    });
  });

  describe('getAppHistory', () => {
    it('should retrieve app deployment history', async () => {
      const mockApp = {
        metadata: { name: 'test-app', creationTimestamp: '2026-02-01T00:00:00Z' },
        status: { sync: { revision: 'abc123' } },
      };

      mockFetch.mockReturnValueOnce(okJson(mockApp));

      const result = await connector.getAppHistory('test-app');
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toMatchObject({
        id: 1,
        revision: 'abc123',
        deployedAt: '2026-02-01T00:00:00Z',
      });
    });

    it('should handle apps without revision', async () => {
      const mockApp = { metadata: { name: 'test-app' } };

      mockFetch.mockReturnValueOnce(okJson(mockApp));

      const result = await connector.getAppHistory('test-app');
      expect(result).toEqual([]);
    });
  });

  describe('refreshApp', () => {
    it('should refresh app successfully', async () => {
      mockFetch.mockReturnValueOnce(okJson({ metadata: { name: 'test-app' } }));

      const result = await connector.refreshApp('test-app');
      expect(result.success).toBe(true);
      expect(result.message).toContain('refreshed');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://argocd.example.com/api/v1/applications/test-app?refresh=true',
        expect.anything(),
      );
    });

    it('should return error on refresh failure', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(503, 'Refresh failed'));

      const result = await connector.refreshApp('test-app');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Refresh failed');
    });
  });

  describe('getAllAppStatuses', () => {
    it('should retrieve statuses for all apps', async () => {
      const mockApps = [
        {
          metadata: { name: 'app1', namespace: 'argocd' },
          status: {
            sync: { status: 'Synced', revision: 'rev1' },
            health: { status: 'Healthy', message: 'OK' },
          },
        },
        {
          metadata: { name: 'app2' },
          status: {
            sync: { status: 'OutOfSync' },
            health: { status: 'Degraded' },
          },
        },
      ];

      mockFetch.mockReturnValueOnce(okJson({ items: mockApps }));

      const result = await connector.getAllAppStatuses();
      expect(result.length).toBe(2);
      expect(result[0]).toMatchObject({
        name: 'app1',
        namespace: 'argocd',
        syncStatus: 'Synced',
        healthStatus: 'Healthy',
        revision: 'rev1',
      });
      expect(result[1]).toMatchObject({
        name: 'app2',
        namespace: 'argocd',
        syncStatus: 'OutOfSync',
        healthStatus: 'Degraded',
      });
    });
  });

  describe('isConfigured', () => {
    it('should return true when both env vars are set', () => {
      process.env.ARGOCD_SERVER = 'https://argocd.example.com';
      process.env.ARGOCD_AUTH_TOKEN = 'token123';

      expect(ArgoCDConnector.isConfigured()).toBe(true);
    });

    it('should return false when env vars are missing', () => {
      delete process.env.ARGOCD_SERVER;
      delete process.env.ARGOCD_AUTH_TOKEN;

      expect(ArgoCDConnector.isConfigured()).toBe(false);
    });
  });
});
