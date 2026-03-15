/**
 * Inventory API Routes
 * Endpoints for listing and managing inventory (hosts and workloads)
 */

import { Router, Request, Response, NextFunction, Application } from 'express';
import type { HostStatus, WorkloadStatus, HealthStatus } from '../../db/types';
import { KubernetesConnector } from '../../connectors/kubernetes';
import { ProxmoxConnector } from '../../connectors/proxmox';
import { NotificationClient } from '../../connectors/notification';
import * as inventory from '../../db/inventory';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * GET /api/v1/inventory
 * Get all hosts and workloads
 */
export async function getInventory(
  _req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const [hosts, workloads] = await Promise.all([
      inventory.getHosts(),
      inventory.getWorkloads(),
    ]);

    res.json({ data: { hosts, workloads } });
  } catch (error) {
    logger.error('Failed to get inventory:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get inventory',
    });
  }
}

/**
 * GET /api/v1/inventory/hosts
 * Get all hosts with optional filtering
 */
export async function getHosts(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { status, type, cluster } = req.query;

    const filters: {
      status?: HostStatus;
      type?: string;
      cluster?: string;
    } = {};

    if (status && typeof status === 'string') {
      filters.status = status as HostStatus;
    }
    if (type && typeof type === 'string') {
      filters.type = type;
    }
    if (cluster && typeof cluster === 'string') {
      filters.cluster = cluster;
    }

    const hosts = await inventory.getHosts(filters);

    res.json({ data: hosts });
  } catch (error) {
    logger.error('Failed to get hosts:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get hosts',
    });
  }
}

/**
 * GET /api/v1/inventory/hosts/:id
 * Get a specific host by ID
 */
export async function getHostById(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Validate UUID format
    if (!isValidUUID(id)) {
      res.status(400).json({ error: 'Invalid host ID format' });
      return;
    }

    const host = await inventory.getHostById(id);

    if (!host) {
      res.status(404).json({ error: 'Host not found' });
      return;
    }

    res.json({ data: host });
  } catch (error) {
    logger.error('Failed to get host by ID:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get host',
    });
  }
}

/**
 * GET /api/v1/inventory/workloads
 * Get all workloads with optional filtering
 */
export async function getWorkloads(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { status, type, namespace, health_status } = req.query;

    const filters: {
      status?: WorkloadStatus;
      type?: string;
      namespace?: string;
      health_status?: HealthStatus;
    } = {};

    if (status && typeof status === 'string') {
      filters.status = status as WorkloadStatus;
    }
    if (type && typeof type === 'string') {
      filters.type = type;
    }
    if (namespace && typeof namespace === 'string') {
      filters.namespace = namespace;
    }
    if (health_status && typeof health_status === 'string') {
      filters.health_status = health_status as HealthStatus;
    }

    const workloads = await inventory.getWorkloads(filters);

    res.json({ data: workloads });
  } catch (error) {
    logger.error('Failed to get workloads:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get workloads',
    });
  }
}

/**
 * GET /api/v1/inventory/workloads/:id
 * Get a specific workload by ID
 */
export async function getWorkloadById(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Validate UUID format
    if (!isValidUUID(id)) {
      res.status(400).json({ error: 'Invalid workload ID format' });
      return;
    }

    const workload = await inventory.getWorkloadById(id);

    if (!workload) {
      res.status(404).json({ error: 'Workload not found' });
      return;
    }

    res.json({ data: workload });
  } catch (error) {
    logger.error('Failed to get workload by ID:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get workload',
    });
  }
}

export interface RefreshResult {
  hostsAdded: number;
  hostsUpdated: number;
  workloadsAdded: number;
  workloadsUpdated: number;
}

/**
 * POST /api/v1/inventory/refresh
 * Trigger inventory sync from Kubernetes
 */
export async function syncInventory(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { forceSync } = req.body || {};

    logger.info('Triggering inventory refresh', { forceSync });
    const existingConnector = req.app.locals
      .kubernetesConnector as KubernetesConnector | undefined;
    const existingProxmoxConnector = req.app.locals
      .proxmoxConnector as ProxmoxConnector | undefined;

    const connector = existingConnector ?? new KubernetesConnector(process.env.KUBECONFIG_PATH);

    if (!existingConnector) {
      await connector.initialize();
    }

    const [k8sInventory, proxmoxInventory] = await Promise.all([
      connector.discoverAll(),
      existingProxmoxConnector
        ? existingProxmoxConnector.discoverAll()
        : shouldInitializeProxmox()
          ? initializeProxmoxConnector(req.app).then((proxmox) => proxmox.discoverAll())
          : Promise.resolve({ hosts: [], workloads: [] }),
    ]);

    const merged = {
      hosts: [...k8sInventory.hosts, ...proxmoxInventory.hosts],
      workloads: [...k8sInventory.workloads, ...proxmoxInventory.workloads],
    };

    const stats = await inventory.syncDiscoveredInventory(merged);

    logger.info('Inventory sync completed', {
      ...stats,
        hostsCount: merged.hosts.length,
        workloadsCount: merged.workloads.length,
    });

    // Publish event to notification service (fire-and-forget)
    const notificationClient = req.app.locals.notificationClient as NotificationClient | undefined;
    if (notificationClient) {
      notificationClient.publishEvent({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: `Inventory sync completed: ${merged.hosts.length} hosts, ${merged.workloads.length} workloads`,
        metadata: { ...stats, hostsCount: merged.hosts.length, workloadsCount: merged.workloads.length },
      });
    }

    res.json({
      data: {
        synced: true,
        hosts_count: merged.hosts.length,
        workloads_count: merged.workloads.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to refresh inventory:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to refresh inventory',
    });
  }
}

export const refreshInventory = syncInventory;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate UUID format (v4 and v5/deterministic)
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function shouldInitializeProxmox(): boolean {
  return Boolean(
    process.env.PROXMOX_HOST &&
      process.env.PROXMOX_TOKEN_ID &&
      process.env.PROXMOX_TOKEN_SECRET
  );
}

async function initializeProxmoxConnector(
  app: Application
): Promise<ProxmoxConnector> {
  const proxmox = new ProxmoxConnector();
  await proxmox.initialize();
  app.locals.proxmoxConnector = proxmox;
  return proxmox;
}

// ============================================================================
// ROUTER SETUP
// ============================================================================

router.get('/', getInventory);
router.get('/hosts', getHosts);
router.get('/hosts/:id', getHostById);
router.get('/workloads', getWorkloads);
router.get('/workloads/:id', getWorkloadById);
router.post('/sync', syncInventory);
router.post('/refresh', refreshInventory);

export default router;
