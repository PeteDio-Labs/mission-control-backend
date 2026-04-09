/**
 * Prometheus Connector
 * Connects to Prometheus API and executes PromQL queries
 */

import { logger } from '../utils/logger';
import { prometheusAvailable, prometheusRequestDuration } from '../metrics/index';

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
  private url: string;
  private timeout = 30000;

  constructor(url?: string) {
    this.url = url || process.env.PROMETHEUS_URL || 'http://kube-prom-stack-kube-prome-prometheus.observability.svc.cluster.local:9090';
    logger.info('Prometheus connector initialized', { url: this.url });
  }

  /**
   * Test connection to Prometheus API
   */
  async testConnection(): Promise<boolean> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.url}/api/v1/status/config`, {
        signal: AbortSignal.timeout(this.timeout),
      });
      prometheusRequestDuration.observe((Date.now() - start) / 1000);
      if (response.ok) {
        prometheusAvailable.set(1);
        logger.info('Prometheus connection test successful');
        return true;
      }
      prometheusAvailable.set(0);
      return false;
    } catch (error) {
      prometheusRequestDuration.observe((Date.now() - start) / 1000);
      prometheusAvailable.set(0);
      logger.error('Prometheus connection test failed', { error });
      return false;
    }
  }

  /**
   * Execute an instant query
   */
  async queryInstant(query: string, time?: string): Promise<PrometheusResponse> {
    const start = Date.now();
    try {
      const params = new URLSearchParams({ query });
      if (time) params.set('time', time);

      const response = await fetch(`${this.url}/api/v1/query?${params}`, {
        signal: AbortSignal.timeout(this.timeout),
      });
      prometheusRequestDuration.observe((Date.now() - start) / 1000);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      prometheusAvailable.set(1);
      const data = await response.json() as PrometheusResponse;
      logger.debug('Prometheus instant query executed', {
        query,
        resultCount: data.data?.result?.length ?? 0,
      });
      return data;
    } catch (error: unknown) {
      prometheusRequestDuration.observe((Date.now() - start) / 1000);
      prometheusAvailable.set(0);
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
    step: string,
  ): Promise<PrometheusResponse> {
    try {
      const params = new URLSearchParams({ query, start, end, step });
      const response = await fetch(`${this.url}/api/v1/query_range?${params}`, {
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as PrometheusResponse;
      logger.debug('Prometheus range query executed', { query, start, end, step });
      return data;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to execute Prometheus range query', { query, error: errorMsg });
      throw error;
    }
  }

  /**
   * Get node CPU usage (percentage)
   */
  async getNodeCPU(): Promise<MetricResult[]> {
    const query = '100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)';
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') throw new Error(response.error || 'Query failed');
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
   */
  async getNodeMemory(): Promise<MetricResult[]> {
    const query = 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes';
    try {
      const response = await this.queryInstant(query);
      if (response.status !== 'success') throw new Error(response.error || 'Query failed');
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
      if (response.status !== 'success') throw new Error(response.error || 'Query failed');
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
      if (response.status !== 'success') throw new Error(response.error || 'Query failed');
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
      const [apiServerResponse, nodeCountResponse, nodesReadyResponse, podCountResponse, podsRunningResponse] =
        await Promise.all([
          this.queryInstant('up{job="apiserver"}'),
          this.queryInstant('count(kube_node_info)'),
          this.queryInstant('sum(kube_node_status_condition{condition="Ready",status="true"})'),
          this.queryInstant('count(kube_pod_info)'),
          this.queryInstant('sum(kube_pod_status_phase{phase="Running"})'),
        ]);

      const apiServerUp =
        apiServerResponse.status === 'success' &&
        apiServerResponse.data.result.length > 0 &&
        !!apiServerResponse.data.result[0].value &&
        apiServerResponse.data.result[0].value[1] === '1';

      const nodeCount =
        nodeCountResponse.status === 'success' && nodeCountResponse.data.result[0]?.value
          ? parseFloat(nodeCountResponse.data.result[0].value[1])
          : 0;

      const nodesReady =
        nodesReadyResponse.status === 'success' && nodesReadyResponse.data.result[0]?.value
          ? parseFloat(nodesReadyResponse.data.result[0].value[1])
          : 0;

      const podCount =
        podCountResponse.status === 'success' && podCountResponse.data.result[0]?.value
          ? parseFloat(podCountResponse.data.result[0].value[1])
          : 0;

      const podsRunning =
        podsRunningResponse.status === 'success' && podsRunningResponse.data.result[0]?.value
          ? parseFloat(podsRunningResponse.data.result[0].value[1])
          : 0;

      const health: HealthMetrics = {
        clusterHealthy: apiServerUp && nodesReady === nodeCount && podsRunning > 0,
        apiServerUp,
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
      if (response.status !== 'success') throw new Error(response.error || 'Query failed');
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
      if (response.status !== 'success') throw new Error(response.error || 'Query failed');
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
