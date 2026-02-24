/**
 * Proxmox API Routes Tests
 * Testing read-only GET endpoints for Proxmox nodes, VMs, LXCs, and cluster resources
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

import {
  getStatus,
  getNodes,
  getNodeStatus,
  getClusterResources,
  getVMs,
  getLXCs,
} from './proxmox';

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

describe('Proxmox API Routes', () => {
  const mockTestConnection = vi.fn();
  const mockGetNodes = vi.fn();
  const mockGetNodeStatus = vi.fn();
  const mockGetClusterResources = vi.fn();
  const mockGetVMs = vi.fn();
  const mockGetLXCs = vi.fn();

  const mockConnector = {
    testConnection: mockTestConnection,
    getNodes: mockGetNodes,
    getNodeStatus: mockGetNodeStatus,
    getClusterResources: mockGetClusterResources,
    getVMs: mockGetVMs,
    getLXCs: mockGetLXCs,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/proxmox/status', () => {
    it('should return connected status', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      mockTestConnection.mockResolvedValue(true);

      await getStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        data: {
          connected: true,
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

    it('should return connected false when test fails', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      mockTestConnection.mockResolvedValue(false);

      await getStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        data: {
          connected: false,
          timestamp: expect.any(String),
        },
      });
    });
  });

  describe('GET /api/v1/proxmox/nodes', () => {
    it('should return all nodes', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      const mockNodes = [
        { node: 'pve', status: 'online', maxcpu: 16, maxmem: 68719476736 },
      ];
      mockGetNodes.mockResolvedValue(mockNodes);

      await getNodes(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockNodes });
    });

    it('should handle errors', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      mockGetNodes.mockRejectedValue(new Error('API error'));

      await getNodes(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/v1/proxmox/nodes/:node/status', () => {
    it('should return node status', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.params = { node: 'pve' };
      const mockStatus = {
        uptime: 86400,
        cpu: 0.15,
        maxcpu: 16,
        memory: { total: 68719476736, used: 34359738368, free: 34359738368 },
      };
      mockGetNodeStatus.mockResolvedValue(mockStatus);

      await getNodeStatus(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockStatus });
    });

    it('should handle errors', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.params = { node: 'badnode' };
      mockGetNodeStatus.mockRejectedValue(new Error('Node not found'));

      await getNodeStatus(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/v1/proxmox/resources', () => {
    it('should return all cluster resources', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      const mockResources = [
        { id: 'node/pve', type: 'node', node: 'pve', status: 'online' },
        { id: 'qemu/101', type: 'qemu', node: 'pve', vmid: 101, name: 'plex', status: 'running' },
        { id: 'lxc/201', type: 'lxc', node: 'pve', vmid: 201, name: 'pihole', status: 'running' },
      ];
      mockGetClusterResources.mockResolvedValue(mockResources);

      await getClusterResources(req, res, next);

      expect(mockGetClusterResources).toHaveBeenCalledWith(undefined);
      expect(res.json).toHaveBeenCalledWith({ data: mockResources });
    });

    it('should filter by type=vm from all nodes', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.query = { type: 'vm' };
      const mockVM = { vmid: 100, name: 'test-vm', node: 'node1', status: 'running' };
      mockConnector.getNodes.mockResolvedValue([{ node: 'node1' }, { node: 'node2' }]);
      mockConnector.getVMs.mockResolvedValue([mockVM]);

      await getClusterResources(req, res, next);

      expect(mockConnector.getNodes).toHaveBeenCalled();
      expect(mockConnector.getVMs).toHaveBeenCalledWith('node1');
      expect(mockConnector.getVMs).toHaveBeenCalledWith('node2');
      expect(res.json).toHaveBeenCalledWith({ data: [mockVM, mockVM] });
    });

    it('should ignore invalid type filter', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.query = { type: 'invalid' };
      mockGetClusterResources.mockResolvedValue([]);

      await getClusterResources(req, res, next);

      expect(mockGetClusterResources).toHaveBeenCalledWith(undefined);
    });

    it('should handle errors', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      mockGetClusterResources.mockRejectedValue(new Error('Cluster error'));

      await getClusterResources(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/v1/proxmox/nodes/:node/vms', () => {
    it('should return VMs for a node', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.params = { node: 'pve' };
      const mockVMs = [
        { vmid: 101, name: 'plex', status: 'running', maxcpu: 4, maxmem: 8589934592 },
        { vmid: 102, name: 'homeassistant', status: 'running', maxcpu: 2, maxmem: 4294967296 },
      ];
      mockGetVMs.mockResolvedValue(mockVMs);

      await getVMs(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockVMs });
    });

    it('should handle errors', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.params = { node: 'pve' };
      mockGetVMs.mockRejectedValue(new Error('API error'));

      await getVMs(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /api/v1/proxmox/nodes/:node/lxc', () => {
    it('should return LXC containers for a node', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.params = { node: 'pve' };
      const mockLXCs = [
        { vmid: 201, name: 'pihole', status: 'running' },
        { vmid: 202, name: 'nginx-proxy', status: 'stopped' },
      ];
      mockGetLXCs.mockResolvedValue(mockLXCs);

      await getLXCs(req, res, next);

      expect(res.json).toHaveBeenCalledWith({ data: mockLXCs });
    });

    it('should handle errors', async () => {
      const { req, res, next } = createMockRequestResponse();
      req.app.locals = { proxmoxConnector: mockConnector };
      req.params = { node: 'pve' };
      mockGetLXCs.mockRejectedValue(new Error('API error'));

      await getLXCs(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
