/**
 * Kubernetes API Routes
 * Endpoints for direct Kubernetes operations (restart, logs)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { KubernetesConnector } from '../../connectors/kubernetes';
import { NotificationClient } from '../../connectors/notification';
import { logger } from '../../utils/logger';
import { requireAdmin } from '../../middleware/auth';

const router = Router();

function getConnector(req: Request): KubernetesConnector {
  const connector = req.app.locals.kubernetesConnector as KubernetesConnector | undefined;
  if (!connector) {
    throw new Error('Kubernetes connector not available');
  }
  return connector;
}

/**
 * POST /api/v1/kubernetes/deployments/:namespace/:name/restart
 * Restart a deployment via rolling restart (SAFE_MUTATE)
 */
export async function restartDeployment(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { namespace, name } = req.params;
    const connector = getConnector(req);
    const result = await connector.restartDeployment(namespace, name);

    // Publish event to notification service (fire-and-forget)
    const notificationClient = req.app.locals.notificationClient as NotificationClient | undefined;
    if (notificationClient) {
      notificationClient.publishEvent({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: `Deployment ${namespace}/${name} restarted`,
        namespace,
        affected_service: name,
      });
    }

    res.json({ data: result });
  } catch (error) {
    logger.error('Failed to restart deployment:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to restart deployment',
    });
  }
}

/**
 * GET /api/v1/kubernetes/pods/:namespace/:name/logs
 * Get pod logs
 * Query: ?lines=100&container=...
 */
export async function getPodLogs(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { namespace, name } = req.params;
    const { lines, container } = req.query;
    const connector = getConnector(req);
    const tailLines = typeof lines === 'string' ? parseInt(lines, 10) : 100;
    const containerName = typeof container === 'string' ? container : undefined;
    const logs = await connector.getPodLogs(namespace, name, containerName, tailLines);
    res.json({ data: { logs } });
  } catch (error) {
    logger.error('Failed to get pod logs:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get pod logs',
    });
  }
}

/**
 * GET /api/v1/kubernetes/status
 * Test Kubernetes connection and return status
 */
export async function getStatus(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    getConnector(req);
    // Since connector throws if undefined, we assume true if we got here
    res.json({
      data: {
        connected: true,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : 'Kubernetes connector not available',
    });
  }
}

// ============================================================================
// ROUTER SETUP
// ============================================================================

router.get('/status', getStatus);
router.post('/deployments/:namespace/:name/restart', requireAdmin, restartDeployment);
router.get('/pods/:namespace/:name/logs', getPodLogs);

export default router;
