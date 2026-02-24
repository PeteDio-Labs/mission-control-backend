/**
 * ArgoCD Connector
 * Connects to ArgoCD API and retrieves application status
 */

import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { logger } from '../utils/logger';

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
  private client: AxiosInstance;
  private server: string;
  private token: string;
  private insecure: boolean;

  constructor(server?: string, token?: string, insecure: boolean = true) {
    this.server = server || process.env.ARGOCD_SERVER || 'http://argocd-server.argocd.svc.cluster.local';
    this.token = token || process.env.ARGOCD_AUTH_TOKEN || '';
    this.insecure = insecure;

    // Ensure server has protocol
    if (!this.server.startsWith('http://') && !this.server.startsWith('https://')) {
      // Default to HTTP for in-cluster connections
      this.server = `http://${this.server}`;
    }

    this.client = axios.create({
      baseURL: this.server,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
      httpsAgent: this.insecure && this.server.startsWith('https://')
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
    });

    logger.info('ArgoCD connector initialized', {
      server: this.server,
      insecure: this.insecure,
      hasToken: !!this.token,
    });
  }

  /**
   * Test connection to ArgoCD API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.get('/api/version');
      logger.info('ArgoCD connection test successful');
      return true;
    } catch (error) {
      let errorMsg = 'Unknown error';
      if (error && typeof error === 'object' && 'message' in error) {
        errorMsg = (error as Error).message;
      }
      logger.error('ArgoCD connection test failed', {
        server: this.server,
        error: errorMsg,
        hasToken: !!this.token
      });
      return false;
    }
  }

  /**
   * Get all ArgoCD applications
   */
  async getApplications(): Promise<ArgoApplication[]> {
    try {
      const response = await this.client.get('/api/v1/applications');
      const items = response.data.items || [];
      logger.info('Retrieved ArgoCD applications', { count: items.length });
      return items;
    } catch (error) {
      logger.error('Failed to get ArgoCD applications', { error });
      throw error;
    }
  }

  /**
   * Get detailed status for a specific application
   */
  async getAppStatus(name: string): Promise<ArgoAppStatus> {
    try {
      const response = await this.client.get(`/api/v1/applications/${name}`);
      const app: ArgoApplication = response.data;

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
      const payload = {
        prune,
        dryRun,
        strategy: {
          hook: {},
        },
      };

      await this.client.post(`/api/v1/applications/${name}/sync`, payload);

      logger.info('ArgoCD app sync triggered', { name, prune, dryRun });
      return {
        success: true,
        message: `Sync operation ${dryRun ? '(dry-run) ' : ''}initiated for ${name}`,
      };
    } catch (error: unknown) {
      let errorMsg = 'Unknown error';
      // Handle axios errors which have a response property
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: { message?: string } } };
        errorMsg = axiosError.response?.data?.message || errorMsg;
      } else if (error instanceof Error) {
        errorMsg = error.message;
      }
      logger.error('Failed to sync ArgoCD app', { name, error: errorMsg });
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get deployment history for an application
   */
  async getAppHistory(name: string): Promise<ArgoRevision[]> {
    try {
      const response = await this.client.get(`/api/v1/applications/${name}`);
      const app: ArgoApplication = response.data;

      // ArgoCD doesn't have a dedicated history endpoint in the basic API
      // We can extract revision info from the current status
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
      await this.client.get(`/api/v1/applications/${name}?refresh=true`);

      logger.info('ArgoCD app refreshed', { name });
      return {
        success: true,
        message: `Application ${name} refreshed`,
      };
    } catch (error: unknown) {
      let errorMsg = 'Unknown error';
      // Handle axios errors which have a response property
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { data?: { message?: string } } };
        errorMsg = axiosError.response?.data?.message || errorMsg;
      } else if (error instanceof Error) {
        errorMsg = error.message;
      }
      logger.error('Failed to refresh ArgoCD app', { name, error: errorMsg });
      return {
        success: false,
        error: errorMsg,
      };
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
