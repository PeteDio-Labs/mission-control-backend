/**
 * qBittorrent Connector
 * Connects to qBittorrent WebUI API v2 for torrent management
 */

import { logger } from '../utils/logger';
import { qbittorrentAvailable, qbittorrentRequestDuration } from '../metrics/index';

export interface TorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dl_speed: number;
  up_speed: number;
  size?: number;
  added_on?: number;
  completion_on?: number;
  category?: string;
  tags?: string;
  ratio?: number;
  eta?: number;
  num_seeds?: number;
  num_leechs?: number;
}

export interface TorrentProperties {
  hash: string;
  name: string;
  comment: string;
  total_size: number;
  total_downloaded: number;
  total_uploaded: number;
  addition_date: number;
  completion_date: number;
}

export interface TransferInfo {
  dl_info_speed: number;
  up_info_speed: number;
  total_uploaded: number;
  total_downloaded: number;
  dht_nodes: number;
}

export interface QBittorrentConnectorOptions {
  host?: string;
  timeout?: number;
}

export class QBittorrentConnector {
  private host: string;
  private timeout: number;

  constructor(options?: QBittorrentConnectorOptions) {
    this.host = options?.host || process.env.QBIT_HOST || 'http://192.168.50.21:8080';
    this.timeout = options?.timeout || 10000;
  }

  async testConnection(): Promise<boolean> {
    try {
      const start = Date.now();
      const response = await fetch(`${this.host}/api/v2/app/version`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });

      const duration = (Date.now() - start) / 1000;
      qbittorrentRequestDuration.observe(duration);

      if (response.ok) {
        qbittorrentAvailable.set(1);
        return true;
      }

      qbittorrentAvailable.set(0);
      return false;
    } catch {
      qbittorrentAvailable.set(0);
      return false;
    }
  }

  async getTorrents(filter?: string): Promise<TorrentInfo[]> {
    return this.makeRequest<TorrentInfo[]>(
      `/api/v2/torrents/info${filter ? `?filter=${filter}` : ''}`
    );
  }

  async getTorrentProperties(hash: string): Promise<TorrentProperties> {
    return this.makeRequest<TorrentProperties>(
      `/api/v2/torrents/properties?hash=${hash}`
    );
  }

  async getTransferInfo(): Promise<TransferInfo> {
    return this.makeRequest<TransferInfo>('/api/v2/transfer/info');
  }

  async isAvailable(): Promise<boolean> {
    return this.testConnection();
  }

  static isConfigured(): boolean {
    return !!process.env.QBIT_HOST;
  }

  private async makeRequest<T>(endpoint: string): Promise<T> {
    const url = `${this.host}${endpoint}`;
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });

      const duration = (Date.now() - start) / 1000;
      qbittorrentRequestDuration.observe(duration);

      if (!response.ok) {
        throw new Error(`qBittorrent API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      const duration = (Date.now() - start) / 1000;
      qbittorrentRequestDuration.observe(duration);

      if (error instanceof Error) {
        logger.error('qBittorrent request failed', { endpoint, error: error.message });
        throw new Error(`Failed to fetch from qBittorrent: ${error.message}`);
      }
      throw error;
    }
  }
}
