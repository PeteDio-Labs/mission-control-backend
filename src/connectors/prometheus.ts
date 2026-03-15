/**
 * Prometheus Connector
 * Connects to Prometheus API and executes PromQL queries
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

export interface PrometheusResult {
  metric: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

export interface PrometheusResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'matrix' | 'vector' | 'scalar' | 'string';
    result: PrometheusResult[];
  };
  error?: string;
  errorType?: string;
}

export interface MetricResult {
  labels: Record<string, string>;
  timestamp: number;
  value: number;
}

export interface HealthMetrics {
  clusterHealthy: boolean;
  apiServerUp: boolean;
  nodeCount: number;
  nodesReady: number;
  podCount: number;
  podsRunning: number;
  timestamp: number;
}

export class PrometheusConnector {
  private client: AxiosInstance;
  private url: string;

  constructor(url?: string) {
    this.url = url || process.env.PROMETHEUS_URL || 'http://kube-prom-stack-kube-prome-prometheus.observability.svc.cluster.local:9090';

    this.client = axios.create({
      baseURL: this.url,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    logger.info('Prometheus connector initialized', { url: this.url });
  }

  /**
   * Test connection to Prometheus API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.get('/api/v1/status/config');
      logger.info('Prometheus connection test successful');
      return true;
    } catch (error) {
      logger.error('Prometheus connection test failed', { error });
      return false;
    }
  }

  /**
   * Execute an instant query
   */
  async queryInstant(query: string, time?: string): Promise<PrometheusResponse> {
    try {
      const params: Record<string, string> = { query };
      if (time) {
        params.time = time;
      }

      const response = await this.client.get('/api/v1/query', { params });
      logger.debug('Prometheus instant query executed', { query, resultCount: response.data.data?.result?.length || 0 });
      return response.data;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to execute Prometheus instant query', { query, error: errorMsg });
      throw error;
    }
  }

  /**
   * Execute a range query
   */
  async queryRange(
    query: string,
    start: string,
    end: string,
    step: string
  ): Promise<PrometheusResponse> {
    try {
      const params = { query, start, end, step };
      const response = await this.client.get('/api/v1/query_range', { params });
      logger.debug('Prometheus range query executed', { query, start, end, step });
      return response.data;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to execute Prometheus range query', { query, error: errorMsg });
      throw error;
    }
  }

  /**
   * Get node CPU usage (percentage)
   * Returns current CPU usage per node
   */
  async getNodeCPU(): Promise<MetricResult[]> {
    const query = '100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)';
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') {
        throw new Error(response.error || 'Query failed');
      }

      return response.data.result.map((r) => ({
        labels: r.metric,
        timestamp: r.value ? r.value[0] : Date.now() / 1000,
        value: r.value ? parseFloat(r.value[1]) : 0,
      }));
    } catch (error) {
      logger.error('Failed to get node CPU metrics', { error });
      return [];
    }
  }

  /**
   * Get node memory usage (bytes used)
   * Returns current memory usage per node
   */
  async getNodeMemory(): Promise<MetricResult[]> {
    const query = 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes';
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') {
        throw new Error(response.error || 'Query failed');
      }

      return response.data.result.map((r) => ({
        labels: r.metric,
        timestamp: r.value ? r.value[0] : Date.now() / 1000,
        value: r.value ? parseFloat(r.value[1]) : 0,
      }));
    } catch (error) {
      logger.error('Failed to get node memory metrics', { error });
      return [];
    }
  }

  /**
   * Get pod resource usage for a namespace
   */
  async getPodResourceUsage(namespace: string): Promise<MetricResult[]> {
    const query = `sum by(pod) (rate(container_cpu_usage_seconds_total{namespace="${namespace}"}[5m]))`;
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') {
        throw new Error(response.error || 'Query failed');
      }

      return response.data.result.map((r) => ({
        labels: r.metric,
        timestamp: r.value ? r.value[0] : Date.now() / 1000,
        value: r.value ? parseFloat(r.value[1]) : 0,
      }));
    } catch (error) {
      logger.error('Failed to get pod resource usage', { namespace, error });
      return [];
    }
  }

  /**
   * Get pod memory usage for a namespace (in bytes)
   */
  async getPodMemoryUsage(namespace: string): Promise<MetricResult[]> {
    const query = `sum by(pod) (container_memory_working_set_bytes{namespace="${namespace}"})`;
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') {
        throw new Error(response.error || 'Query failed');
      }

      return response.data.result.map((r) => ({
        labels: r.metric,
        timestamp: r.value ? r.value[0] : Date.now() / 1000,
        value: r.value ? parseFloat(r.value[1]) : 0,
      }));
    } catch (error) {
      logger.error('Failed to get pod memory usage', { namespace, error });
      return [];
    }
  }

  /**
   * Get cluster health metrics
   */
  async getClusterHealth(): Promise<HealthMetrics> {
    try {
      // Check if API server is up
      const apiServerQuery = 'up{job="kubernetes-apiservers"}';
      const apiServerResponse = await this.queryInstant(apiServerQuery);
      const apiServerUp: boolean =
        apiServerResponse.status === 'success' &&
        apiServerResponse.data.result.length > 0 &&
        !!apiServerResponse.data.result[0].value &&
        apiServerResponse.data.result[0].value[1] === '1';

      // Count total nodes
      const nodeCountQuery = 'count(kube_node_info)';
      const nodeCountResponse = await this.queryInstant(nodeCountQuery);
      const nodeCount =
        nodeCountResponse.status === 'success' && nodeCountResponse.data.result[0]?.value
          ? parseFloat(nodeCountResponse.data.result[0].value[1])
          : 0;

      // Count ready nodes
      const nodesReadyQuery = 'sum(kube_node_status_condition{condition="Ready",status="true"})';
      const nodesReadyResponse = await this.queryInstant(nodesReadyQuery);
      const nodesReady =
        nodesReadyResponse.status === 'success' && nodesReadyResponse.data.result[0]?.value
          ? parseFloat(nodesReadyResponse.data.result[0].value[1])
          : 0;

      // Count total pods
      const podCountQuery = 'count(kube_pod_info)';
      const podCountResponse = await this.queryInstant(podCountQuery);
      const podCount =
        podCountResponse.status === 'success' && podCountResponse.data.result[0]?.value
          ? parseFloat(podCountResponse.data.result[0].value[1])
          : 0;

      // Count running pods
      const podsRunningQuery = 'sum(kube_pod_status_phase{phase="Running"})';
      const podsRunningResponse = await this.queryInstant(podsRunningQuery);
      const podsRunning =
        podsRunningResponse.status === 'success' && podsRunningResponse.data.result[0]?.value
          ? parseFloat(podsRunningResponse.data.result[0].value[1])
          : 0;

      const health: HealthMetrics = {
        clusterHealthy: apiServerUp && nodesReady === nodeCount && podsRunning > 0,
        apiServerUp: apiServerUp,
        nodeCount,
        nodesReady,
        podCount,
        podsRunning,
        timestamp: Date.now(),
      };

      logger.info('Retrieved cluster health metrics', health);
      return health;
    } catch (error) {
      logger.error('Failed to get cluster health metrics', { error });
      return {
        clusterHealthy: false,
        apiServerUp: false,
        nodeCount: 0,
        nodesReady: 0,
        podCount: 0,
        podsRunning: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Get deployment replica counts
   */
  async getDeploymentReplicas(namespace?: string): Promise<MetricResult[]> {
    const namespaceFilter = namespace ? `namespace="${namespace}",` : '';
    const query = `kube_deployment_status_replicas_available{${namespaceFilter}}`;
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') {
        throw new Error(response.error || 'Query failed');
      }

      return response.data.result.map((r) => ({
        labels: r.metric,
        timestamp: r.value ? r.value[0] : Date.now() / 1000,
        value: r.value ? parseFloat(r.value[1]) : 0,
      }));
    } catch (error) {
      logger.error('Failed to get deployment replicas', { namespace, error });
      return [];
    }
  }

  /**
   * Get persistent volume usage
   */
  async getPVUsage(): Promise<MetricResult[]> {
    const query = '(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) * 100';
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') {
        throw new Error(response.error || 'Query failed');
      }

      return response.data.result.map((r) => ({
        labels: r.metric,
        timestamp: r.value ? r.value[0] : Date.now() / 1000,
        value: r.value ? parseFloat(r.value[1]) : 0,
      }));
    } catch (error) {
      logger.error('Failed to get PV usage', { error });
      return [];
    }
  }

  /**
   * Check if Prometheus is configured
   */
  static isConfigured(): boolean {
    return !!process.env.PROMETHEUS_URL || true; // Default URL is available
  }
}
