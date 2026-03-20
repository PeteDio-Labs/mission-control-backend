/**
 * Proxmox API Routes
 * Endpoints for Proxmox node/VM/LXC management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { ProxmoxConnector } from '../../connectors/proxmox';
import { NotificationClient } from '../../connectors/notification';
import { logger } from '../../utils/logger';

function publishProxmoxEvent(
  req: Request,
  type: 'vm-status' | 'lxc-status',
  action: string,
  node: string,
  vmid: string
): void {
  const notificationClient = req.app.locals.notificationClient as NotificationClient | undefined;
  if (notificationClient) {
    notificationClient.publishEvent({
      source: 'proxmox',
      type,
      severity: 'info',
      message: `${type === 'vm-status' ? 'VM' : 'LXC'} ${vmid} on ${node} ${action}`,
      affected_service: `${node}/${vmid}`,
    });
  }
}

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

    // Handle VM resources specially - collect from all nodes
    if (type === 'vm') {
      const nodes = await connector.getNodes();
      const allVMs = [];

      for (const node of nodes) {
        try {
          const vms = await connector.getVMs(node.node);
          allVMs.push(...vms);
        } catch (error) {
          logger.warn(`Failed to get VMs for node ${node.node}:`, error);
        }
      }

      res.json({ data: allVMs });
      return;
    }

    const validTypes = ['node', 'storage'] as const;
    const filterType = typeof type === 'string' && validTypes.includes(type as 'node' | 'storage')
      ? (type as 'node' | 'storage')
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

/**
 * POST /api/v1/proxmox/nodes/:node/vms/:vmid/start
 * Start a VM (SAFE_MUTATE)
 */
export async function startVM(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node, vmid } = req.params;
    const connector = getConnector(req);
    const result = await connector.startVM(node, Number(vmid));
    publishProxmoxEvent(req, 'vm-status', 'started', node, vmid);
    res.json({ data: { success: true, message: result } });
  } catch (error) {
    logger.error('Failed to start VM:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start VM',
    });
  }
}

/**
 * POST /api/v1/proxmox/nodes/:node/vms/:vmid/stop
 * Stop a VM (SAFE_MUTATE)
 */
export async function stopVM(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node, vmid } = req.params;
    const connector = getConnector(req);
    const result = await connector.stopVM(node, Number(vmid));
    publishProxmoxEvent(req, 'vm-status', 'stopped', node, vmid);
    res.json({ data: { success: true, message: result } });
  } catch (error) {
    logger.error('Failed to stop VM:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to stop VM',
    });
  }
}

/**
 * POST /api/v1/proxmox/nodes/:node/vms/:vmid/restart
 * Restart a VM (SAFE_MUTATE)
 */
export async function restartVM(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node, vmid } = req.params;
    const connector = getConnector(req);
    const result = await connector.restartVM(node, Number(vmid));
    publishProxmoxEvent(req, 'vm-status', 'restarted', node, vmid);
    res.json({ data: { success: true, message: result } });
  } catch (error) {
    logger.error('Failed to restart VM:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to restart VM',
    });
  }
}

/**
 * POST /api/v1/proxmox/nodes/:node/lxc/:vmid/start
 * Start an LXC container (SAFE_MUTATE)
 */
export async function startLXC(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node, vmid } = req.params;
    const connector = getConnector(req);
    const result = await connector.startLXC(node, Number(vmid));
    publishProxmoxEvent(req, 'lxc-status', 'started', node, vmid);
    res.json({ data: { success: true, message: result } });
  } catch (error) {
    logger.error('Failed to start LXC:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start LXC',
    });
  }
}

/**
 * POST /api/v1/proxmox/nodes/:node/lxc/:vmid/stop
 * Stop an LXC container (SAFE_MUTATE)
 */
export async function stopLXC(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node, vmid } = req.params;
    const connector = getConnector(req);
    const result = await connector.stopLXC(node, Number(vmid));
    publishProxmoxEvent(req, 'lxc-status', 'stopped', node, vmid);
    res.json({ data: { success: true, message: result } });
  } catch (error) {
    logger.error('Failed to stop LXC:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to stop LXC',
    });
  }
}

/**
 * POST /api/v1/proxmox/nodes/:node/lxc/:vmid/restart
 * Restart an LXC container (SAFE_MUTATE)
 */
export async function restartLXC(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { node, vmid } = req.params;
    const connector = getConnector(req);
    const result = await connector.restartLXC(node, Number(vmid));
    publishProxmoxEvent(req, 'lxc-status', 'restarted', node, vmid);
    res.json({ data: { success: true, message: result } });
  } catch (error) {
    logger.error('Failed to restart LXC:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to restart LXC',
    });
  }
}

// ============================================================================
// ROUTER SETUP
// ============================================================================

// Read-only
router.get('/status', getStatus);
router.get('/resources', getClusterResources);
router.get('/nodes', getNodes);
router.get('/nodes/:node/status', getNodeStatus);
router.get('/nodes/:node/vms', getVMs);
router.get('/nodes/:node/lxc', getLXCs);

// Mutations (SAFE_MUTATE)
router.post('/nodes/:node/vms/:vmid/start', startVM);
router.post('/nodes/:node/vms/:vmid/stop', stopVM);
router.post('/nodes/:node/vms/:vmid/restart', restartVM);
router.post('/nodes/:node/lxc/:vmid/start', startLXC);
router.post('/nodes/:node/lxc/:vmid/stop', stopLXC);
router.post('/nodes/:node/lxc/:vmid/restart', restartLXC);

export default router;
