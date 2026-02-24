/**
 * Proxmox API Routes
 * Endpoints for Proxmox node/VM/LXC management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { ProxmoxConnector } from '../../connectors/proxmox';
import { logger } from '../../utils/logger';

const router = Router();

function getConnector(req: Request): ProxmoxConnector {
  const connector = req.app.locals.proxmoxConnector as ProxmoxConnector | undefined;
  if (!connector) {
    throw new Error('Proxmox connector not available');
  }
  return connector;
}

/**
 * GET /api/v1/proxmox/status
 * Test Proxmox connection and return status
 */
export async function getStatus(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const connected = await connector.testConnection();
    res.json({
      data: {
        connected,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to get Proxmox status:', error);
    res.status(503).json({
      error: error instanceof Error ? error.message : 'Proxmox connector not available',
    });
  }
}

/**
 * GET /api/v1/proxmox/nodes
 * List all Proxmox nodes
 */
export async function getNodes(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const nodes = await connector.getNodes();
    res.json({ data: nodes });
  } catch (error) {
    logger.error('Failed to get Proxmox nodes:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get nodes',
    });
  }
}

/**
 * GET /api/v1/proxmox/nodes/:node/status
 * Get detailed status for a specific node
 */
export async function getNodeStatus(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node } = req.params;
    const connector = getConnector(req);
    const status = await connector.getNodeStatus(node);
    res.json({ data: status });
  } catch (error) {
    logger.error('Failed to get node status:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get node status',
    });
  }
}

/**
 * GET /api/v1/proxmox/resources
 * Get all cluster resources in a single call (nodes, VMs, LXCs)
 * Query: ?type=node|vm|storage|lxc
 */
export async function getClusterResources(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { type } = req.query;
    const connector = getConnector(req);

    // Handle LXC resources specially - collect from all nodes
    if (type === 'lxc') {
      const nodes = await connector.getNodes();
      const allLXCs = [];

      for (const node of nodes) {
        try {
          const lxcs = await connector.getLXCs(node.node);
          allLXCs.push(...lxcs);
        } catch (error) {
          logger.warn(`Failed to get LXCs for node ${node.node}:`, error);
        }
      }

      res.json({ data: allLXCs });
      return;
    }

    const validTypes = ['node', 'vm', 'storage'] as const;
    const filterType = typeof type === 'string' && validTypes.includes(type as 'node' | 'vm' | 'storage')
      ? (type as 'node' | 'vm' | 'storage')
      : undefined;
    const resources = await connector.getClusterResources(filterType);
    res.json({ data: resources });
  } catch (error) {
    logger.error('Failed to get cluster resources:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get cluster resources',
    });
  }
}

/**
 * GET /api/v1/proxmox/nodes/:node/vms
 * List all QEMU VMs on a node
 */
export async function getVMs(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node } = req.params;
    const connector = getConnector(req);
    const vms = await connector.getVMs(node);
    res.json({ data: vms });
  } catch (error) {
    logger.error('Failed to get VMs:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get VMs',
    });
  }
}

/**
 * GET /api/v1/proxmox/nodes/:node/lxc
 * List all LXC containers on a node
 */
export async function getLXCs(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node } = req.params;
    const connector = getConnector(req);
    const lxcs = await connector.getLXCs(node);
    res.json({ data: lxcs });
  } catch (error) {
    logger.error('Failed to get LXC containers:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get LXC containers',
    });
  }
}

// ============================================================================
// ROUTER SETUP (READ_ONLY)
// ============================================================================

router.get('/status', getStatus);
router.get('/resources', getClusterResources);
router.get('/nodes', getNodes);
router.get('/nodes/:node/status', getNodeStatus);
router.get('/nodes/:node/vms', getVMs);
router.get('/nodes/:node/lxc', getLXCs);

export default router;
