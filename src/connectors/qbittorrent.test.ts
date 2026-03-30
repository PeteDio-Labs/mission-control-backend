/**
 * QBittorrentConnector Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { QBittorrentConnector } from './qbittorrent';

describe('QBittorrentConnector.addTorrent', () => {
  let connector: QBittorrentConnector;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new QBittorrentConnector({ host: 'http://qbit:8080' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls the correct endpoint with form-encoded body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await connector.addTorrent('magnet:?xt=urn:btih:abc', 'tv-sonarr');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://qbit:8080/api/v2/torrents/add',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );

    const callArgs = mockFetch.mock.calls[0][1];
    const params = new URLSearchParams(callArgs.body as string);
    expect(params.get('urls')).toBe('magnet:?xt=urn:btih:abc');
    expect(params.get('category')).toBe('tv-sonarr');
  });

  it('works with radarr category', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await connector.addTorrent('magnet:?xt=urn:btih:xyz', 'radarr');

    const callArgs = mockFetch.mock.calls[0][1];
    const params = new URLSearchParams(callArgs.body as string);
    expect(params.get('category')).toBe('radarr');
  });

  it('throws when the API returns a non-ok status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    }) as unknown as typeof fetch;

    await expect(connector.addTorrent('magnet:?xt=urn:btih:abc', 'radarr')).rejects.toThrow(
      'Failed to add torrent'
    );
  });

  it('throws when fetch rejects (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await expect(connector.addTorrent('magnet:?xt=urn:btih:abc', 'radarr')).rejects.toThrow(
      'Failed to add torrent: ECONNREFUSED'
    );
  });
});
