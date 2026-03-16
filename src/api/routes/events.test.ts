import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { streamEvents, receiveWebhook, eventBus, getClientCount } from './events';

// Mock metrics
vi.mock('../../metrics', () => ({
  sseConnections: { set: vi.fn() },
  sseEventsBroadcast: { inc: vi.fn() },
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createMockSSEResponse() {
  const res = {
    writeHead: vi.fn(),
    write: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function createMockRequest(overrides?: Partial<Request>) {
  const listeners: Record<string, Function[]> = {};
  const req = {
    body: {},
    on: vi.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    _emit: (event: string) => {
      (listeners[event] || []).forEach((cb) => cb());
    },
    ...overrides,
  } as unknown as Request & { _emit: (event: string) => void };
  return req;
}

describe('Events SSE Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus.removeAllListeners();
  });

  describe('GET /stream (SSE)', () => {
    it('sets correct SSE headers', () => {
      const req = createMockRequest();
      const res = createMockSSEResponse();

      streamEvents(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Cleanup
      req._emit('close');
    });

    it('sends initial connection event', () => {
      const req = createMockRequest();
      const res = createMockSSEResponse();

      streamEvents(req, res);

      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"connected"')
      );

      req._emit('close');
    });

    it('tracks client connections', () => {
      const req = createMockRequest();
      const res = createMockSSEResponse();

      expect(getClientCount()).toBe(0);
      streamEvents(req, res);
      expect(getClientCount()).toBe(1);

      req._emit('close');
      expect(getClientCount()).toBe(0);
    });

    it('forwards events from bus to connected clients', () => {
      const req = createMockRequest();
      const res = createMockSSEResponse();

      streamEvents(req, res);

      const testEvent = { source: 'kubernetes', type: 'deployment', message: 'test' };
      eventBus.emit('event', testEvent);

      expect(res.write).toHaveBeenCalledWith(
        `data: ${JSON.stringify(testEvent)}\n\n`
      );

      req._emit('close');
    });
  });

  describe('POST /webhook', () => {
    it('broadcasts event to SSE clients', () => {
      // Connect an SSE client first
      const sseReq = createMockRequest();
      const sseRes = createMockSSEResponse();
      streamEvents(sseReq, sseRes);

      // Clear initial write calls
      (sseRes.write as ReturnType<typeof vi.fn>).mockClear();

      // Send webhook
      const webhookEvent = {
        id: '123',
        source: 'argocd',
        type: 'rollout',
        severity: 'info',
        message: 'Sync triggered',
        timestamp: new Date().toISOString(),
      };

      const req = createMockRequest({ body: { event: webhookEvent, subscription: { id: 's1', name: 'test' } } });
      const res = createMockSSEResponse();

      receiveWebhook(req as unknown as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'ok' });

      // SSE client should have received the event
      expect(sseRes.write).toHaveBeenCalledWith(
        `data: ${JSON.stringify(webhookEvent)}\n\n`
      );

      sseReq._emit('close');
    });

    it('returns 400 if event is missing', () => {
      const req = createMockRequest({ body: {} });
      const res = createMockSSEResponse();

      receiveWebhook(req as unknown as Request, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing event in request body' });
    });

    it('returns 200 even with no connected clients', () => {
      const webhookEvent = { source: 'kubernetes', type: 'deployment', message: 'test' };
      const req = createMockRequest({ body: { event: webhookEvent } });
      const res = createMockSSEResponse();

      receiveWebhook(req as unknown as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
