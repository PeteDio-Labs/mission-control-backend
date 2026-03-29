/**
 * ArgoCD Connector
 * Connects to ArgoCD API and retrieves application status
 */

import { logger } from '../utils/logger';
import { argoCdAvailable, argoCdRequestDuration } from '../metrics/index';

export interface ArgoApplication {
  metadata: {
    name: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    source: {
      repoURL: string;
      path?: string;
      targetRevision?: string;
      chart?: string;
    };
    destination: {
      server: string;
      namespace?: string;
    };
    project: string;
  };
  status?: {
    sync?: {
      status: 'Synced' | 'OutOfSync' | 'Unknown';
      revision?: string;
    };
    health?: {
      status: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';
      message?: string;
    };
    conditions?: Array<{
      type: string;
      message: string;
      lastTransitionTime?: string;
    }>;
    operationState?: {
      phase: string;
      message?: string;
      startedAt?: string;
      finishedAt?: string;
    };
    resources?: Array<{
      group?: string;
      kind: string;
      name: string;
      namespace?: string;
      status?: string;
      health?: {
        status: string;
      };
    }>;
  };
}

export interface ArgoAppStatus {
  name: string;
  namespace: string;
  syncStatus: 'Synced' | 'OutOfSync' | 'Unknown';
  healthStatus: 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';
  revision?: string;
  message?: string;
  resources?: Array<{
    kind: string;
    name: string;
    namespace?: string;
    status?: string;
    health?: string;
  }>;
}

export interface SyncResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface ArgoRevision {
  id: number;
  revision: string;
  deployedAt: string;
  author?: string;
  message?: string;
}

export class ArgoCDConnector {
  private server: string;
  private token: string;
  private timeout = 20000;

  constructor(server?: string, token?: string, _insecure: boolean = true) {
    this.server = server || process.env.ARGOCD_SERVER || 'http://argocd-server.argocd.svc.cluster.local';
    this.token = token || process.env.ARGOCD_AUTH_TOKEN || '';

    // Ensure server has protocol
    if (!this.server.startsWith('http://') && !this.server.startsWith('https://')) {
      this.server = `http://${this.server}`;
    }

    logger.info('ArgoCD connector initialized', {
      server: this.server,
      hasToken: !!this.token,
    });
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const url = `${this.server}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let msg: string;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? `HTTP ${response.status}`;
      } catch {
        msg = `HTTP ${response.status} ${response.statusText}`;
      }
      throw new Error(msg);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Test connection to ArgoCD API
   */
  async testConnection(): Promise<boolean> {
    const start = Date.now();
    try {
      await this.request('/api/version');
      argoCdRequestDuration.observe((Date.now() - start) / 1000);
      argoCdAvailable.set(1);
      logger.info('ArgoCD connection test successful');
      return true;
    } catch (error) {
      argoCdRequestDuration.observe((Date.now() - start) / 1000);
      argoCdAvailable.set(0);
      logger.error('ArgoCD connection test failed', {
        server: this.server,
        error: error instanceof Error ? error.message : 'Unknown error',
        hasToken: !!this.token,
      });
      return false;
    }
  }

  /**
   * Get all ArgoCD applications
   */
  async getApplications(): Promise<ArgoApplication[]> {
    const start = Date.now();
    try {
      const data = await this.request<{ items?: ArgoApplication[] }>('/api/v1/applications');
      argoCdRequestDuration.observe((Date.now() - start) / 1000);
      argoCdAvailable.set(1);
      const items = data.items ?? [];
      logger.info('Retrieved ArgoCD applications', { count: items.length });
      return items;
    } catch (error) {
      argoCdRequestDuration.observe((Date.now() - start) / 1000);
      argoCdAvailable.set(0);
      logger.error('Failed to get ArgoCD applications', { error });
      throw error;
    }
  }

  /**
   * Get detailed status for a specific application
   */
  async getAppStatus(name: string): Promise<ArgoAppStatus> {
    try {
      const app = await this.request<ArgoApplication>(`/api/v1/applications/${encodeURIComponent(name)}`);

      const status: ArgoAppStatus = {
        name: app.metadata.name,
        namespace: app.metadata.namespace || 'argocd',
        syncStatus: app.status?.sync?.status || 'Unknown',
        healthStatus: app.status?.health?.status || 'Unknown',
        revision: app.status?.sync?.revision,
        message: app.status?.health?.message || app.status?.conditions?.[0]?.message,
        resources: app.status?.resources?.map((r) => ({
          kind: r.kind,
          name: r.name,
          namespace: r.namespace,
          status: r.status,
          health: r.health?.status,
        })),
      };

      logger.info('Retrieved ArgoCD app status', { name, status: status.syncStatus });
      return status;
    } catch (error) {
      logger.error('Failed to get ArgoCD app status', { name, error });
      throw error;
    }
  }

  /**
   * Trigger a sync operation for an application (SAFE_MUTATE)
   */
  async syncApp(name: string, prune: boolean = false, dryRun: boolean = false): Promise<SyncResult> {
    try {
      const payload = { prune, dryRun, strategy: { hook: {} } };
      await this.request(`/api/v1/applications/${encodeURIComponent(name)}/sync`, 'POST', payload);
      logger.info('ArgoCD app sync triggered', { name, prune, dryRun });
      return {
        success: true,
        message: `Sync operation ${dryRun ? '(dry-run) ' : ''}initiated for ${name}`,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to sync ArgoCD app', { name, error: errorMsg });
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get deployment history for an application
   */
  async getAppHistory(name: string): Promise<ArgoRevision[]> {
    try {
      const app = await this.request<ArgoApplication>(`/api/v1/applications/${encodeURIComponent(name)}`);

      const revisions: ArgoRevision[] = [];
      if (app.status?.sync?.revision) {
        revisions.push({
          id: 1,
          revision: app.status.sync.revision,
          deployedAt: app.metadata.creationTimestamp || new Date().toISOString(),
          message: 'Current revision',
        });
      }

      logger.info('Retrieved ArgoCD app history', { name, count: revisions.length });
      return revisions;
    } catch (error) {
      logger.error('Failed to get ArgoCD app history', { name, error });
      throw error;
    }
  }

  /**
   * Refresh an application (re-check Git without syncing)
   */
  async refreshApp(name: string): Promise<SyncResult> {
    try {
      await this.request(`/api/v1/applications/${encodeURIComponent(name)}?refresh=true`);
      logger.info('ArgoCD app refreshed', { name });
      return { success: true, message: `Application ${name} refreshed` };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to refresh ArgoCD app', { name, error: errorMsg });
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get all applications with their statuses (summary view)
   */
  async getAllAppStatuses(): Promise<ArgoAppStatus[]> {
    try {
      const apps = await this.getApplications();
      return apps.map((app) => ({
        name: app.metadata.name,
        namespace: app.metadata.namespace || 'argocd',
        syncStatus: app.status?.sync?.status || 'Unknown',
        healthStatus: app.status?.health?.status || 'Unknown',
        revision: app.status?.sync?.revision,
        message: app.status?.health?.message,
      }));
    } catch (error) {
      logger.error('Failed to get all ArgoCD app statuses', { error });
      throw error;
    }
  }

  /**
   * Check if ArgoCD credentials are configured
   */
  static isConfigured(): boolean {
    return !!(process.env.ARGOCD_SERVER && process.env.ARGOCD_AUTH_TOKEN);
  }
}
