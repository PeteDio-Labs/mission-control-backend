/**
 * ArgoCD API Routes Tests
 * Testing endpoints for ArgoCD application status and sync management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

import { getStatus, getAllAppStatuses, getAppStatus, syncApp } from './argocd';

function createMockRequestResponse() {
  const req = {
    params: {},
    query: {},
    body: {},
    app: {
      locals: {},
    },
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as unknown as NextFunction;

  return { req, res, next };
}

describe('ArgoCD API Routes', () => {
  const mockTestConnection = vi.fn();
  const mockGetAllAppStatuses = vi.fn();
  const mockGetAppStatus = vi.fn();
  const mockSyncApp = vi.fn();

  const mockConnector = {
    testConnection: mockTestConnection,
    getAllAppStatuses: mockGetAllAppStatuses,
    getAppStatus: mockGetAppStatus,
    syncApp: mockSyncApp,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/argocd/status', () => {
    it('should return connected status', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      mockTestConnection.mockResolvedValue(true);

      await getStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        data: {
          connected: true,
          timestamp: expect.any(String),
        },
      });
    });

    it('should return connected false when test fails', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      mockTestConnection.mockResolvedValue(false);

      await getStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        data: {
          connected: false,
          timestamp: expect.any(String),
        },
      });
    });

    it('should return 503 when connector is not available', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = {};

      await getStatus(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe('GET /api/v1/argocd/applications', () => {
    it('should return all application statuses', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      const mockStatuses = [
        { name: 'app1', namespace: 'argocd', syncStatus: 'Synced', healthStatus: 'Healthy' },
        { name: 'app2', namespace: 'argocd', syncStatus: 'OutOfSync', healthStatus: 'Degraded' },
      ];
      mockGetAllAppStatuses.mockResolvedValue(mockStatuses);

      await getAllAppStatuses(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockStatuses });
    });

    it('should return empty array when no applications', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      mockGetAllAppStatuses.mockResolvedValue([]);

      await getAllAppStatuses(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: [] });
    });

    it('should return 500 when connector is not available', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = {};

      await getAllAppStatuses(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should return 500 on API error', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      mockGetAllAppStatuses.mockRejectedValue(new Error('API error'));

      await getAllAppStatuses(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/v1/argocd/applications/:name', () => {
    it('should return status for a specific application', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      req.params = { name: 'my-app' };
      const mockStatus = {
        name: 'my-app',
        namespace: 'argocd',
        syncStatus: 'Synced',
        healthStatus: 'Healthy',
        revision: 'abc123',
      };
      mockGetAppStatus.mockResolvedValue(mockStatus);

      await getAppStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockStatus });
    });

    it('should return 500 when connector is not available', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = {};
      req.params = { name: 'my-app' };

      await getAppStatus(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should return 500 when application is not found', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      req.params = { name: 'nonexistent-app' };
      mockGetAppStatus.mockRejectedValue(new Error('Application not found'));

      await getAppStatus(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Application not found' })
      );
    });
  });

  describe('POST /api/v1/argocd/applications/:name/sync', () => {
    it('should trigger sync for an application', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      req.params = { name: 'my-app' };
      const mockResult = { success: true, message: 'Sync operation initiated for my-app' };
      mockSyncApp.mockResolvedValue(mockResult);

      await syncApp(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockResult });
    });

    it('should return 500 when connector is not available', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = {};
      req.params = { name: 'my-app' };

      await syncApp(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should return 500 on sync error', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { argoCDConnector: mockConnector };
      req.params = { name: 'my-app' };
      mockSyncApp.mockRejectedValue(new Error('Sync failed'));

      await syncApp(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
