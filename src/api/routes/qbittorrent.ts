/**
 * qBittorrent API Routes
 * Endpoints for qBittorrent torrent management and transfer info
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { QBittorrentConnector } from '../../connectors/qbittorrent';
import { logger } from '../../utils/logger';

const AddTorrentSchema = z.object({
  magnetUrl: z.string().min(1, 'magnetUrl is required').startsWith('magnet:', 'Must be a magnet link'),
  category: z.enum(['tv-sonarr', 'radarr']),
});

const router = Router();

function getConnector(req: Request): QBittorrentConnector {
  const connector = req.app.locals.qbittorrentConnector as QBittorrentConnector | undefined;
  if (!connector) {
    throw new Error('qBittorrent connector not available');
  }
  return connector;
}

/**
 * GET /api/v1/qbittorrent/status
 * Test qBittorrent connection and return status
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
    logger.error('Failed to get qBittorrent status:', error);
    res.status(503).json({
      error: error instanceof Error ? error.message : 'qBittorrent connector not available',
    });
  }
}

/**
 * GET /api/v1/qbittorrent/torrents
 * List torrents with optional filter
 * Query: ?filter=downloading|seeding|completed|paused|active|inactive|stalled
 */
export async function getTorrents(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { filter } = req.query;
    const connector = getConnector(req);
    const torrents = await connector.getTorrents(
      typeof filter === 'string' ? filter : undefined
    );
    res.json({ data: torrents });
  } catch (error) {
    logger.error('Failed to get torrents:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get torrents',
    });
  }
}

/**
 * GET /api/v1/qbittorrent/torrents/:hash
 * Get properties for a specific torrent
 */
export async function getTorrentDetails(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const { hash } = req.params;
    const connector = getConnector(req);
    const properties = await connector.getTorrentProperties(hash);
    res.json({ data: properties });
  } catch (error) {
    logger.error('Failed to get torrent details:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get torrent details',
    });
  }
}

/**
 * GET /api/v1/qbittorrent/transfer
 * Get global transfer info (speeds, totals)
 */
export async function getTransferInfo(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  try {
    const connector = getConnector(req);
    const transfer = await connector.getTransferInfo();
    res.json({ data: transfer });
  } catch (error) {
    logger.error('Failed to get transfer info:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get transfer info',
    });
  }
}

/**
 * POST /api/v1/qbittorrent/torrents
 * Add a torrent by magnet link
 * Body: { magnetUrl: string, category: 'tv-sonarr' | 'radarr' }
 */
export async function addTorrent(
  req: Request,
  res: Response,
  _next: NextFunction
): Promise<void> {
  const parsed = AddTorrentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0].message });
    return;
  }

  try {
    const connector = getConnector(req);
    await connector.addTorrent(parsed.data.magnetUrl, parsed.data.category);
    res.status(200).json({ data: { success: true } });
  } catch (error) {
    logger.error('Failed to add torrent:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to add torrent',
    });
  }
}

// ============================================================================
// ROUTER SETUP
// ============================================================================

router.get('/status', getStatus);
router.get('/torrents', getTorrents);
router.post('/torrents', addTorrent);
router.get('/torrents/:hash', getTorrentDetails);
router.get('/transfer', getTransferInfo);

export default router;
