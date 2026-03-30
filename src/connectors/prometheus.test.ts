/**
 * Prometheus Connector Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrometheusConnector } from './prometheus';

const mockFetch = vi.fn();

function okJson(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  });
}

function vectorResponse(results: Array<{ metric: Record<string, string>; value: [number, string] }>) {
  return okJson({
    status: 'success',
    data: { resultType: 'vector', result: results },
  });
}

describe('PrometheusConnector', () => {
  let connector: PrometheusConnector;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    connector = new PrometheusConnector('http://prometheus.example.com:9090');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('initialization', () => {
    it('should initialize with provided URL', () => {
      expect(connector).toBeDefined();
    });

    it('should use environment variable as fallback', () => {
      process.env.PROMETHEUS_URL = 'http://env-prometheus.com:9090';
      const c = new PrometheusConnector();
      expect(c).toBeDefined();
      delete process.env.PROMETHEUS_URL;
    });

    it('should use default URL if none provided', () => {
      delete process.env.PROMETHEUS_URL;
      const c = new PrometheusConnector();
      expect(c).toBeDefined();
    });
  });

  describe('testConnection', () => {
    it('should return true on successful connection', async () => {
      mockFetch.mockReturnValueOnce(okJson({ status: 'success' }));

      const result = await connector.testConnection();
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://prometheus.example.com:9090/api/v1/status/config',
        expect.anything(),
      );
    });

    it('should return false on connection failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

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
          result: [{ metric: { instance: 'node1' }, value: [1707408000, '75.5'] }],
        },
      };

      mockFetch.mockReturnValueOnce(okJson(mockResponse));

      const result = await connector.queryInstant('up');
      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/query?'),
        expect.anything(),
      );
      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain('query=up');
    });

    it('should support optional time parameter', async () => {
      const mockResponse = {
        status: 'success',
        data: { resultType: 'vector', result: [] },
      };

      mockFetch.mockReturnValueOnce(okJson(mockResponse));

      await connector.queryInstant('up', '2026-02-08T12:00:00Z');
      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain('query=up');
      expect(url).toContain('time=');
    });

    it('should throw on query error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Query failed'));

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

      mockFetch.mockReturnValueOnce(okJson(mockResponse));

      const result = await connector.queryRange('up', '1707408000', '1707408600', '60');
      expect(result).toEqual(mockResponse);
      const url: string = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/v1/query_range?');
      expect(url).toContain('query=up');
      expect(url).toContain('step=60');
    });
  });

  describe('getNodeCPU', () => {
    it('should retrieve node CPU metrics', async () => {
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { instance: 'node1' }, value: [1707408000, '45.3'] },
        { metric: { instance: 'node2' }, value: [1707408000, '62.1'] },
      ]));

      const result = await connector.getNodeCPU();
      expect(result.length).toBe(2);
      expect(result[0]).toMatchObject({ labels: { instance: 'node1' }, value: 45.3 });
      expect(result[1]).toMatchObject({ labels: { instance: 'node2' }, value: 62.1 });
    });

    it('should return empty array on query failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getNodeCPU();
      expect(result).toEqual([]);
    });
  });

  describe('getNodeMemory', () => {
    it('should retrieve node memory metrics', async () => {
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { instance: 'node1' }, value: [1707408000, '8589934592'] },
      ]));

      const result = await connector.getNodeMemory();
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(8589934592);
    });

    it('should return empty array on query failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getNodeMemory();
      expect(result).toEqual([]);
    });
  });

  describe('getPodResourceUsage', () => {
    it('should retrieve pod CPU usage for namespace', async () => {
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { pod: 'app-pod-1' }, value: [1707408000, '0.25'] },
        { metric: { pod: 'app-pod-2' }, value: [1707408000, '0.18'] },
      ]));

      const result = await connector.getPodResourceUsage('default');
      expect(result.length).toBe(2);
      expect(result[0].labels.pod).toBe('app-pod-1');
      expect(result[0].value).toBe(0.25);
    });

    it('should return empty array on query failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Query failed'));

      const result = await connector.getPodResourceUsage('default');
      expect(result).toEqual([]);
    });
  });

  describe('getPodMemoryUsage', () => {
    it('should retrieve pod memory usage for namespace', async () => {
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { pod: 'app-pod-1' }, value: [1707408000, '536870912'] },
      ]));

      const result = await connector.getPodMemoryUsage('default');
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(536870912);
    });
  });

  describe('getClusterHealth', () => {
    it('should retrieve comprehensive cluster health metrics', async () => {
      const makeVectorResponse = (value: string) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          status: 'success',
          data: { resultType: 'vector', result: [{ metric: {}, value: [1707408000, value] }] },
        }),
      });

      mockFetch
        .mockReturnValueOnce(makeVectorResponse('1'))  // apiServerUp
        .mockReturnValueOnce(makeVectorResponse('3'))  // nodeCount
        .mockReturnValueOnce(makeVectorResponse('3'))  // nodesReady
        .mockReturnValueOnce(makeVectorResponse('50')) // podCount
        .mockReturnValueOnce(makeVectorResponse('48')); // podsRunning

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
      mockFetch.mockRejectedValue(new Error('Query failed'));

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
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { deployment: 'app1', namespace: 'default' }, value: [1707408000, '3'] },
      ]));

      const result = await connector.getDeploymentReplicas();
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(3);
    });

    it('should retrieve deployment replicas with namespace filter', async () => {
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { deployment: 'app1', namespace: 'production' }, value: [1707408000, '5'] },
      ]));

      const result = await connector.getDeploymentReplicas('production');
      expect(result.length).toBe(1);
      expect(result[0].labels.namespace).toBe('production');
    });
  });

  describe('getPVUsage', () => {
    it('should retrieve persistent volume usage', async () => {
      mockFetch.mockReturnValueOnce(vectorResponse([
        { metric: { persistentvolumeclaim: 'data-pvc' }, value: [1707408000, '75.5'] },
      ]));

      const result = await connector.getPVUsage();
      expect(result.length).toBe(1);
      expect(result[0].value).toBe(75.5);
    });

    it('should return empty array on query failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Query failed'));

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
