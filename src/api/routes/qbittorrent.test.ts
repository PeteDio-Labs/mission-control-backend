/**
 * qBittorrent API Routes Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { addTorrent } from './qbittorrent';

function createMockRequestResponse() {
  const req = {
    params: {},
    query: {},
    body: {},
    app: { locals: {} },
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as unknown as NextFunction;

  return { req, res, next };
}

describe('POST /api/v1/qbittorrent/torrents', () => {
  const mockAddTorrent = vi.fn();
  const mockConnector = {
    testConnection: vi.fn(),
    getTorrents: vi.fn(),
    getTransferInfo: vi.fn(),
    addTorrent: mockAddTorrent,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 and success on valid magnet + tv-sonarr category', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = { qbittorrentConnector: mockConnector };
    req.body = { magnetUrl: 'magnet:?xt=urn:btih:abc123', category: 'tv-sonarr' };
    mockAddTorrent.mockResolvedValue(undefined);

    await addTorrent(req, res, next);

    expect(mockAddTorrent).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc123', 'tv-sonarr');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: { success: true } });
  });

  it('returns 200 and success on valid magnet + radarr category', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = { qbittorrentConnector: mockConnector };
    req.body = { magnetUrl: 'magnet:?xt=urn:btih:abc123', category: 'radarr' };
    mockAddTorrent.mockResolvedValue(undefined);

    await addTorrent(req, res, next);

    expect(mockAddTorrent).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc123', 'radarr');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 400 when magnetUrl is missing', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = { qbittorrentConnector: mockConnector };
    req.body = { category: 'radarr' };

    await addTorrent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(mockAddTorrent).not.toHaveBeenCalled();
  });

  it('returns 400 when category is invalid', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = { qbittorrentConnector: mockConnector };
    req.body = { magnetUrl: 'magnet:?xt=urn:btih:abc123', category: 'not-a-category' };

    await addTorrent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAddTorrent).not.toHaveBeenCalled();
  });

  it('returns 400 when magnetUrl does not start with magnet:', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = { qbittorrentConnector: mockConnector };
    req.body = { magnetUrl: 'http://not-a-magnet.com/file.torrent', category: 'radarr' };

    await addTorrent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAddTorrent).not.toHaveBeenCalled();
  });

  it('returns 500 when connector throws', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = { qbittorrentConnector: mockConnector };
    req.body = { magnetUrl: 'magnet:?xt=urn:btih:abc123', category: 'radarr' };
    mockAddTorrent.mockRejectedValue(new Error('qBit unreachable'));

    await addTorrent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('qBit unreachable') })
    );
  });

  it('returns 500 when connector is not available', async () => {
    const { req, res, next } = createMockRequestResponse();
    req.app.locals = {};
    req.body = { magnetUrl: 'magnet:?xt=urn:btih:abc123', category: 'tv-sonarr' };

    await addTorrent(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
