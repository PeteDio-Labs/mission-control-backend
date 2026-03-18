/**
 * ArgoCD API Routes
 * Endpoints for ArgoCD application status and sync management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { ArgoCDConnector } from '../../connectors/argocd';
import { NotificationClient } from '../../connectors/notification';
import { logger } from '../../utils/logger';

const router = Router();

function getConnector(req: Request): ArgoCDConnector {
  const connector = req.app.locals.argoCDConnector as ArgoCDConnector | undefined;
  if (!connector) {
    throw new Error('ArgoCD connector not available');
  }
  return connector;
}

/**
 * GET /api/v1/argocd/status
 * Test ArgoCD connection and return status
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
    logger.error('Failed to get ArgoCD status:', error);
    res.status(503).json({
      error: error instanceof Error ? error.message : 'ArgoCD connector not available',
    });
  }
}

/**
 * GET /api/v1/argocd/applications
 * List all ArgoCD applications with sync/health status
 */
export async function getAllAppStatuses(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const statuses = await connector.getAllAppStatuses();
    res.json({ data: statuses });
  } catch (error) {
    logger.error('Failed to get ArgoCD application statuses:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get application statuses',
    });
  }
}

/**
 * GET /api/v1/argocd/applications/:name
 * Get detailed status for a specific application
 */
export async function getAppStatus(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { name } = req.params;
    const connector = getConnector(req);
    const status = await connector.getAppStatus(name);
    res.json({ data: status });
  } catch (error) {
    logger.error('Failed to get ArgoCD app status:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get application status',
    });
  }
}

/**
 * POST /api/v1/argocd/applications/:name/sync
 * Trigger sync operation for an application (SAFE_MUTATE)
 */
export async function syncApp(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { name } = req.params;
    const connector = getConnector(req);
    const result = await connector.syncApp(name);

    // Publish event to notification service (fire-and-forget)
    const notificationClient = req.app.locals.notificationClient as NotificationClient | undefined;
    if (notificationClient && result.success) {
      notificationClient.publishEvent({
        source: 'argocd',
        type: 'rollout',
        severity: 'info',
        message: `ArgoCD sync triggered for ${name}`,
        affected_service: name,
      });
    }

    res.json({ data: result });
  } catch (error) {
    logger.error('Failed to sync ArgoCD app:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to sync application',
    });
  }
}

/**
 * GET /api/v1/argocd/applications/:name/history
 * Get deployment history for an application
 */
export async function getAppHistory(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { name } = req.params;
    const connector = getConnector(req);
    const history = await connector.getAppHistory(name);
    res.json({ data: history });
  } catch (error) {
    logger.error('Failed to get ArgoCD app history:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get application history',
    });
  }
}

/**
 * POST /api/v1/argocd/applications/:name/refresh
 * Force a git re-check for an application
 */
export async function refreshApp(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { name } = req.params;
    const connector = getConnector(req);
    const result = await connector.refreshApp(name);
    res.json({ data: result });
  } catch (error) {
    logger.error('Failed to refresh ArgoCD app:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to refresh application',
    });
  }
}

// ============================================================================
// ROUTER SETUP
// ============================================================================

router.get('/status', getStatus);
router.get('/applications', getAllAppStatuses);
router.get('/applications/:name', getAppStatus);
router.get('/applications/:name/history', getAppHistory);
router.post('/applications/:name/sync', syncApp);
router.post('/applications/:name/refresh', refreshApp);

export default router;
