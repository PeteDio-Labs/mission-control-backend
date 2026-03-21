/**
 * SSE Event Stream + Webhook Receiver
 *
 * - GET  /api/v1/events/stream  — SSE endpoint for live event streaming
 * - POST /api/v1/events/webhook — Webhook callback from notification-service
 */

import { Router, Request, Response } from 'express';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { sseConnections, sseEventsBroadcast } from '../../metrics';

const router = Router();

// In-memory event bus for SSE broadcast
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

// Track connected SSE clients
const clients = new Set<Response>();

/**
 * GET /stream — Server-Sent Events endpoint
 */
export function streamEvents(req: Request, res: Response): void {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  clients.add(res);
  sseConnections.set(clients.size);
  logger.debug(`SSE client connected (total: ${clients.size})`);

  // Keepalive ping every 30s
  const keepalive = setInterval(() => {
    res.write(': ping\n\n');
  }, 30000);

  // Forward events from bus to this client
  const onEvent = (event: unknown) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  eventBus.on('event', onEvent);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    eventBus.off('event', onEvent);
    clients.delete(res);
    sseConnections.set(clients.size);
    logger.debug(`SSE client disconnected (total: ${clients.size})`);
  });
}

/**
 * POST /webhook — Receives events from notification-service fan-out
 */
export function receiveWebhook(req: Request, res: Response): void {
  const { event } = req.body;

  if (!event) {
    res.status(400).json({ error: 'Missing event in request body' });
    return;
  }

  // Broadcast to all SSE clients
  eventBus.emit('event', event);
  sseEventsBroadcast.inc();

  logger.debug('Webhook event received and broadcast', {
    source: event.source,
    type: event.type,
    clients: clients.size,
  });

  res.status(200).json({ status: 'ok' });
}

/**
 * Get the current number of connected SSE clients (for testing)
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * GET / — Proxy to notification-service for historical events
 */
async function listEvents(req: Request, res: Response): Promise<void> {
  const notifUrl =
    process.env.NOTIFICATION_SERVICE_URL ||
    'http://notification-service.mission-control.svc.cluster.local:3002';

  const limit = req.query.limit ?? '50';
  try {
    const response = await fetch(`${notifUrl}/api/v1/events?limit=${limit}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      res.status(response.status).json({ error: `Notification service error: ${response.statusText}` });
      return;
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    logger.error('Failed to proxy events from notification-service', err);
    res.status(502).json({ error: 'Notification service unavailable' });
  }
}

router.get('/', listEvents);
router.get('/stream', streamEvents);
router.post('/webhook', receiveWebhook);

export default router;
