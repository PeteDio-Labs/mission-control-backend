/**
 * Prometheus API Routes
 * Endpoints for Prometheus metrics and cluster health
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrometheusConnector } from '../../connectors/prometheus';
import { logger } from '../../utils/logger';

const router = Router();

function getConnector(req: Request): PrometheusConnector {
  const connector = req.app.locals.prometheusConnector as PrometheusConnector | undefined;
  if (!connector) {
    throw new Error('Prometheus connector not available');
  }
  return connector;
}

/**
 * GET /api/v1/prometheus/status
 * Test Prometheus connection and return status
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
    logger.error('Failed to get Prometheus status:', error);
    res.status(503).json({
      error: error instanceof Error ? error.message : 'Prometheus connector not available',
    });
  }
}

/**
 * GET /api/v1/prometheus/nodes/cpu
 * Get node CPU usage percentages
 */
export async function getNodeCPU(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const metrics = await connector.getNodeCPU();
    res.json({ data: metrics });
  } catch (error) {
    logger.error('Failed to get node CPU metrics:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get node CPU metrics',
    });
  }
}

/**
 * GET /api/v1/prometheus/nodes/memory
 * Get node memory usage
 */
export async function getNodeMemory(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const metrics = await connector.getNodeMemory();
    res.json({ data: metrics });
  } catch (error) {
    logger.error('Failed to get node memory metrics:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get node memory metrics',
    });
  }
}

/**
 * GET /api/v1/prometheus/pods/:namespace
 * Get pod resource usage for a namespace
 */
export async function getPodUsage(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { namespace } = req.params;
    const connector = getConnector(req);
    const [cpu, memory] = await Promise.all([
      connector.getPodResourceUsage(namespace),
      connector.getPodMemoryUsage(namespace),
    ]);
    res.json({ data: { cpu, memory } });
  } catch (error) {
    logger.error('Failed to get pod usage:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get pod usage',
    });
  }
}

/**
 * GET /api/v1/prometheus/cluster/health
 * Get cluster health summary
 */
export async function getClusterHealth(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const health = await connector.getClusterHealth();
    res.json({ data: health });
  } catch (error) {
    logger.error('Failed to get cluster health:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get cluster health',
    });
  }
}

/**
 * GET /api/v1/prometheus/pvs
 * Get persistent volume usage
 */
export async function getPVUsage(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const metrics = await connector.getPVUsage();
    res.json({ data: metrics });
  } catch (error) {
    logger.error('Failed to get PV usage:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get PV usage',
    });
  }
}

/**
 * GET /api/v1/prometheus/query
 * Execute a generic instant PromQL query
 * Query: ?query=...&time=...
 */
export async function queryInstant(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { query, time } = req.query;
    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'Missing required query parameter' });
      return;
    }
    const connector = getConnector(req);
    const result = await connector.queryInstant(query, typeof time === 'string' ? time : undefined);
    res.json({ data: result });
  } catch (error) {
    logger.error('Failed to execute Prometheus query:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to execute query',
    });
  }
}

// ============================================================================
// ROUTER SETUP (READ_ONLY)
// ============================================================================

router.get('/status', getStatus);
router.get('/nodes/cpu', getNodeCPU);
router.get('/nodes/memory', getNodeMemory);
router.get('/pods/:namespace', getPodUsage);
router.get('/cluster/health', getClusterHealth);
router.get('/pvs', getPVUsage);
router.get('/query', queryInstant);

export default router;
