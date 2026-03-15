/**
 * Prometheus Connector Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { PrometheusConnector } from './prometheus';

vi.mock('axios', () => ({
  default: {
    create: vi.fn(),
  },
}));

const mockedAxios = axios as any;

describe('PrometheusConnector', () => {
  let connector: PrometheusConnector;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      get: vi.fn(),
    };

    mockedAxios.create = vi.fn().mockReturnValue(mockClient);

    connector = new PrometheusConnector('http://prometheus.example.com:9090');
  });

  describe('initialization', () => {
    it('should initialize with provided URL', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://prometheus.example.com:9090',
          timeout: 30000,
        })
      );
    });

    it('should use environment variable as fallback', () => {
      process.env.PROMETHEUS_URL = 'http://env-prometheus.com:9090';
      const connector2 = new PrometheusConnector();

      expect(mockedAxios.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseURL: 'http://env-prometheus.com:9090',
        })
      );
    });

    it('should use default URL if none provided', () => {
      delete process.env.PROMETHEUS_URL;
      const connector2 = new PrometheusConnector();

      expect(mockedAxios.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseURL: 'http://kube-prom-stack-kube-prome-prometheus.observability.svc.cluster.local:9090',
        })
      );
    });
  });

  describe('testConnection', () => {
    it('should return true on successful connection', async () => {
      mockClient.get.mockResolvedValueOnce({ data: { status: 'success' } });

      const result = await connector.testConnection();
      expect(result).toBe(true);
      expect(mockClient.get).toHaveBeenCalledWith('/api/v1/status/config');
    });

    it('should return false on connection failure', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await connector.testConnection();
      expect(result).toBe(false);
    });
  });

  describe('queryInstant', () => {
    it('should execute instant query successfully', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { instance: 'node1' },
              value: [1707408000, '75.5'],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.queryInstant('up');
      expect(result).toEqual(mockResponse);
      expect(mockClient.get).toHaveBeenCalledWith('/api/v1/query', {
        params: { query: 'up' },
      });
    });

    it('should support optional time parameter', async () => {
      const mockResponse = {
        status: 'success',
        data: { resultType: 'vector', result: [] },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      await connector.queryInstant('up', '2026-02-08T12:00:00Z');
      expect(mockClient.get).toHaveBeenCalledWith('/api/v1/query', {
        params: { query: 'up', time: '2026-02-08T12:00:00Z' },
      });
    });

    it('should throw on query error', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Query failed'));

      await expect(connector.queryInstant('invalid_query')).rejects.toThrow('Query failed');
    });
  });

  describe('queryRange', () => {
    it('should execute range query successfully', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { instance: 'node1' },
              values: [
                [1707408000, '75.5'],
                [1707408060, '76.2'],
              ],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.queryRange('up', '1707408000', '1707408600', '60');
      expect(result).toEqual(mockResponse);
      expect(mockClient.get).toHaveBeenCalledWith('/api/v1/query_range', {
        params: {
          query: 'up',
          start: '1707408000',
          end: '1707408600',
          step: '60',
        },
      });
    });
  });

  describe('getNodeCPU', () => {
    it('should retrieve node CPU metrics', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { instance: 'node1' },
              value: [1707408000, '45.3'],
            },
            {
              metric: { instance: 'node2' },
              value: [1707408000, '62.1'],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getNodeCPU();
      expect(result.length).toBe(2);
      expect(result[0]).toMatchObject({
        labels: { instance: 'node1' },
        value: 45.3,
      });
      expect(result[1]).toMatchObject({
        labels: { instance: 'node2' },
        value: 62.1,
      });
    });

    it('should return empty array on query failure', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getNodeCPU();
      expect(result).toEqual([]);
    });
  });

  describe('getNodeMemory', () => {
    it('should retrieve node memory metrics', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { instance: 'node1' },
              value: [1707408000, '8589934592'], // 8GB in bytes
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getNodeMemory();
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(8589934592);
    });

    it('should return empty array on query failure', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getNodeMemory();
      expect(result).toEqual([]);
    });
  });

  describe('getPodResourceUsage', () => {
    it('should retrieve pod CPU usage for namespace', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { pod: 'app-pod-1' },
              value: [1707408000, '0.25'],
            },
            {
              metric: { pod: 'app-pod-2' },
              value: [1707408000, '0.18'],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getPodResourceUsage('default');
      expect(result.length).toBe(2);
      expect(result[0].labels.pod).toBe('app-pod-1');
      expect(result[0].value).toBe(0.25);
    });

    it('should return empty array on query failure', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getPodResourceUsage('default');
      expect(result).toEqual([]);
    });
  });

  describe('getPodMemoryUsage', () => {
    it('should retrieve pod memory usage for namespace', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { pod: 'app-pod-1' },
              value: [1707408000, '536870912'], // 512MB
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getPodMemoryUsage('default');
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(536870912);
    });
  });

  describe('getClusterHealth', () => {
    it('should retrieve comprehensive cluster health metrics', async () => {
      // Mock API server check
      mockClient.get.mockResolvedValueOnce({
        data: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: {}, value: [1707408000, '1'] }],
          },
        },
      });

      // Mock node count
      mockClient.get.mockResolvedValueOnce({
        data: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: {}, value: [1707408000, '3'] }],
          },
        },
      });

      // Mock nodes ready
      mockClient.get.mockResolvedValueOnce({
        data: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: {}, value: [1707408000, '3'] }],
          },
        },
      });

      // Mock pod count
      mockClient.get.mockResolvedValueOnce({
        data: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: {}, value: [1707408000, '50'] }],
          },
        },
      });

      // Mock pods running
      mockClient.get.mockResolvedValueOnce({
        data: {
          status: 'success',
          data: {
            resultType: 'vector',
            result: [{ metric: {}, value: [1707408000, '48'] }],
          },
        },
      });

      const result = await connector.getClusterHealth();
      expect(result).toMatchObject({
        clusterHealthy: true,
        apiServerUp: true,
        nodeCount: 3,
        nodesReady: 3,
        podCount: 50,
        podsRunning: 48,
      });
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should return unhealthy status on failure', async () => {
      mockClient.get.mockRejectedValue(new Error('Query failed'));

      const result = await connector.getClusterHealth();
      expect(result).toMatchObject({
        clusterHealthy: false,
        apiServerUp: false,
        nodeCount: 0,
        nodesReady: 0,
        podCount: 0,
        podsRunning: 0,
      });
    });
  });

  describe('getDeploymentReplicas', () => {
    it('should retrieve deployment replicas without namespace filter', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { deployment: 'app1', namespace: 'default' },
              value: [1707408000, '3'],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getDeploymentReplicas();
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(3);
    });

    it('should retrieve deployment replicas with namespace filter', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { deployment: 'app1', namespace: 'production' },
              value: [1707408000, '5'],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getDeploymentReplicas('production');
      expect(result.length).toBe(1);
      expect(result[0].labels.namespace).toBe('production');
    });
  });

  describe('getPVUsage', () => {
    it('should retrieve persistent volume usage', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { persistentvolumeclaim: 'data-pvc' },
              value: [1707408000, '75.5'],
            },
          ],
        },
      };

      mockClient.get.mockResolvedValueOnce({ data: mockResponse });

      const result = await connector.getPVUsage();
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(75.5);
    });

    it('should return empty array on query failure', async () => {
      mockClient.get.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getPVUsage();
      expect(result).toEqual([]);
    });
  });

  describe('isConfigured', () => {
    it('should always return true (default URL available)', () => {
      expect(PrometheusConnector.isConfigured()).toBe(true);
    });
  });
});
