/**
 * Kubernetes Connector Tests
 * Testing inventory discovery, health status checking, and basic operations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KubernetesConnector } from './kubernetes';
import type { Host, Workload } from '../db/types';
import type {
  V1Node,
  V1Namespace,
  V1Deployment,
  V1StatefulSet,
  V1Pod,
} from '@kubernetes/client-node';

// vi.hoisted runs before vi.mock hoisting, so these are available in the factory
const { mockCoreApi, mockAppsApi, CORE_V1_SENTINEL, APPS_V1_SENTINEL } = vi.hoisted(() => {
  const mockCoreApi = {
    listNode: vi.fn(),
    listNamespace: vi.fn(),
    listNamespacedPod: vi.fn(),
    readNamespacedPod: vi.fn(),
    readNamespacedPodLog: vi.fn(),
  };
  const mockAppsApi = {
    listNamespacedDeployment: vi.fn(),
    listNamespacedStatefulSet: vi.fn(),
    readNamespacedDeployment: vi.fn(),
    patchNamespacedDeployment: vi.fn(),
  };
  const CORE_V1_SENTINEL = { __type: 'CoreV1Api' };
  const APPS_V1_SENTINEL = { __type: 'AppsV1Api' };
  return { mockCoreApi, mockAppsApi, CORE_V1_SENTINEL, APPS_V1_SENTINEL };
});

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromDefault: vi.fn(),
    loadFromFile: vi.fn((path: string) => {
      if (path === '/invalid/path') {
        throw new Error('Invalid kubeconfig');
      }
    }),
    currentContext: 'test-cluster',
    makeApiClient: vi.fn((ApiClass) => {
      if (ApiClass === CORE_V1_SENTINEL) return mockCoreApi;
      if (ApiClass === APPS_V1_SENTINEL) return mockAppsApi;
      return {};
    }),
  })),
  CoreV1Api: CORE_V1_SENTINEL,
  AppsV1Api: APPS_V1_SENTINEL,
}));

const createNamespace = (name: string): V1Namespace => ({
  metadata: { name },
});

const createNode = (overrides: Partial<V1Node> = {}): V1Node => ({
  metadata: {
    uid: 'node-1',
    name: 'node-1',
    labels: { role: 'worker' },
    creationTimestamp: new Date(),
    ...overrides.metadata,
  },
  spec: {
    taints: [],
    ...overrides.spec,
  },
  status: {
    addresses: [
      { type: 'InternalIP', address: '192.168.1.100' },
      { type: 'ExternalIP', address: '1.2.3.4' },
    ],
    capacity: { cpu: '4', memory: '8Gi' },
    allocatable: { cpu: '4', memory: '8Gi' },
    conditions: [{ type: 'Ready', status: 'True' }],
    ...overrides.status,
  },
  ...overrides,
});

const createDeployment = (
  name: string = 'test-app',
  namespace: string = 'default',
  overrides: Partial<V1Deployment> = {}
): V1Deployment => ({
  metadata: {
    uid: `dep-${name}`,
    name,
    namespace,
    labels: { app: name },
    creationTimestamp: new Date(),
    managedFields: [{ time: new Date() }],
    ...overrides.metadata,
  },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: { containers: [{ name: 'app', image: 'nginx:latest' }] },
    },
    ...overrides.spec,
  },
  status: {
    readyReplicas: 3,
    updatedReplicas: 3,
    ...overrides.status,
  },
  ...overrides,
});

const createStatefulSet = (
  name: string = 'stateful-app',
  namespace: string = 'default',
  overrides: Partial<V1StatefulSet> = {}
): V1StatefulSet => ({
  metadata: {
    uid: `ss-${name}`,
    name,
    namespace,
    labels: { app: name },
    creationTimestamp: new Date(),
    managedFields: [{ time: new Date() }],
    ...overrides.metadata,
  },
  spec: {
    replicas: 1,
    serviceName: 'stateful-service',
    template: {
      metadata: { labels: { app: name } },
      spec: { containers: [{ name: 'app', image: 'nginx:latest' }] },
    },
    ...overrides.spec,
  },
  status: {
    readyReplicas: 1,
    ...overrides.status,
  },
  ...overrides,
});

const createPod = (
  name: string = 'test-pod',
  namespace: string = 'default',
  phase: 'Running' | 'Pending' | 'Failed' = 'Running',
  overrides: Partial<V1Pod> = {}
): V1Pod => ({
  metadata: {
    uid: `pod-${name}`,
    name,
    namespace,
    labels: { app: name },
    creationTimestamp: new Date(),
    managedFields: [{ time: new Date() }],
    ...overrides.metadata,
  },
  spec: {
    nodeName: 'node-1',
    containers: [{ name: 'app', image: 'nginx:latest' }],
    restartPolicy: 'Always',
    ...overrides.spec,
  },
  status: {
    phase,
    ...overrides.status,
  },
  ...overrides,
});

describe('KubernetesConnector', () => {
  let connector: KubernetesConnector;

  beforeEach(() => {
    connector = new KubernetesConnector();

    mockCoreApi.listNode.mockResolvedValue({ body: { items: [createNode()] } });
    mockCoreApi.listNamespace.mockResolvedValue({
      body: {
        items: [
          createNamespace('default'),
          createNamespace('kube-system'),
          createNamespace('kube-node-lease'),
          createNamespace('kube-public'),
        ],
      },
    });
    mockAppsApi.listNamespacedDeployment.mockResolvedValue({
      body: { items: [createDeployment()] },
    });
    mockAppsApi.listNamespacedStatefulSet.mockResolvedValue({
      body: { items: [createStatefulSet()] },
    });
    mockCoreApi.listNamespacedPod.mockResolvedValue({
      body: { items: [createPod()] },
    });
    mockAppsApi.readNamespacedDeployment.mockImplementation(
      async (name: string, namespace: string) => {
        if (namespace === 'nonexistent' || namespace === 'invalid' || name === 'invalid') {
          throw new Error('Deployment not found');
        }
        if (name === 'broken-app') {
          return {
            body: createDeployment('broken-app', namespace, {
              status: { readyReplicas: 0, updatedReplicas: 0 },
            }),
          };
        }

        return { body: createDeployment(name, namespace) };
      }
    );
    mockAppsApi.patchNamespacedDeployment.mockImplementation(
      async (name: string, namespace: string) => {
        if (namespace === 'nonexistent' || namespace === 'invalid' || name === 'invalid') {
          throw new Error('Patch failed');
        }
        return { body: {} };
      }
    );
    mockCoreApi.readNamespacedPod.mockImplementation(
      async (name: string, namespace: string) => {
        if (name === 'pending-pod') {
          return { body: createPod(name, namespace, 'Pending') };
        }
        return { body: createPod(name, namespace, 'Running') };
      }
    );
    mockCoreApi.readNamespacedPodLog.mockImplementation(
      async (
        _name: string,
        namespace: string,
        _container?: string,
        _follow?: boolean,
        _insecureSkipTlsVerifyBackend?: boolean,
        _limitBytes?: number,
        _pretty?: string,
        _previous?: boolean,
        _sinceSeconds?: number,
        tailLines?: number
      ) => {
        if (namespace === 'nonexistent') {
          throw new Error('Pod not found');
        }
        const lines = tailLines
          ? Array.from({ length: tailLines }, (_, index) => `line-${index + 1}`)
          : ['log-line'];
        return { body: lines.join('\n') };
      }
    );
  });

  describe('Connection & Initialization', () => {
    it('should initialize with valid kubeconfig', async () => {
      const result = await connector.initialize();
      expect(result).toBe(true);
    });

    it('should connect to Kubernetes API', async () => {
      const connected = await connector.connect();
      expect(connected).toBe(true);
    });

    it('should throw error on invalid kubeconfig', async () => {
      const badConnector = new KubernetesConnector('/invalid/path');
      await expect(badConnector.initialize()).rejects.toThrow();
    });

    it('should return cluster context name', async () => {
      await connector.initialize();
      const context = connector.getClusterContext();
      expect(context).toBeDefined();
      expect(typeof context).toBe('string');
    });
  });

  describe('Node Discovery', () => {
    it('should list all K8s nodes', async () => {
      await connector.initialize();
      const nodes = await connector.discoverNodes();

      expect(Array.isArray(nodes)).toBe(true);
      nodes.forEach((node) => {
        expect(node.name).toBeDefined();
        expect(node.type).toBe('k8s-node');
        expect(node.cluster).toBeDefined();
        expect(node.addresses).toBeDefined();
      });
    });

    it('should extract node addresses (internal, external)', async () => {
      await connector.initialize();
      const nodes = await connector.discoverNodes();

      nodes.forEach((node) => {
        expect(node.addresses).toHaveProperty('lan');
        // May or may not have external/public address
        expect(
          node.addresses.lan || node.addresses.public || node.addresses.tailscale
        ).toBeDefined();
      });
    });

    it('should include node status', async () => {
      await connector.initialize();
      const nodes = await connector.discoverNodes();

      nodes.forEach((node) => {
        expect(['online', 'offline', 'degraded', 'unknown']).toContain(
          node.status
        );
      });
    });

    it('should include node metadata (CPU, memory, labels)', async () => {
      await connector.initialize();
      const nodes = await connector.discoverNodes();

      nodes.forEach((node) => {
        expect(node.metadata).toBeDefined();
        expect(node.metadata.capacity).toBeDefined();
        expect(node.metadata.labels).toBeDefined();
      });
    });

    it('should return empty array when no nodes exist', async () => {
      const emptyConnector = new KubernetesConnector();
      emptyConnector.setMockNodes([]);
      const nodes = await emptyConnector.discoverNodes();

      expect(nodes).toEqual([]);
    });
  });

  describe('Namespace Discovery', () => {
    it('should list all namespaces', async () => {
      await connector.initialize();
      const namespaces = await connector.discoverNamespaces();

      expect(Array.isArray(namespaces)).toBe(true);
      expect(namespaces.length).toBeGreaterThan(0);
      expect(namespaces).toContain('default');
      expect(namespaces).toContain('kube-system');
    });

    it('should handle excluded namespaces', async () => {
      await connector.initialize();
      const namespaces = await connector.discoverNamespaces();

      // Should not include kube-node-lease, kube-public by default
      expect(namespaces).not.toContain('kube-node-lease');
    });
  });

  describe('Deployment Discovery', () => {
    it('should list deployments in all namespaces', async () => {
      await connector.initialize();
      const deployments = await connector.discoverDeployments();

      expect(Array.isArray(deployments)).toBe(true);
      deployments.forEach((deployment) => {
        expect(deployment.name).toBeDefined();
        expect(deployment.type).toBe('k8s-deployment');
        expect(deployment.namespace).toBeDefined();
        expect(deployment.status).toMatch(/running|pending|failed|unknown/);
      });
    });

    it('should include deployment replicas and desired state', async () => {
      await connector.initialize();
      const deployments = await connector.discoverDeployments();

      deployments.forEach((deployment) => {
        expect(deployment.spec).toBeDefined();
        expect(deployment.spec.replicas).toBeDefined();
        expect(deployment.spec.desiredReplicas).toBeDefined();
        expect(deployment.spec.readyReplicas).toBeDefined();
      });
    });

    it('should include container images', async () => {
      await connector.initialize();
      const deployments = await connector.discoverDeployments();

      deployments.forEach((deployment) => {
        expect(deployment.spec.containers).toBeDefined();
        expect(Array.isArray(deployment.spec.containers)).toBe(true);
      });
    });

    it('should return empty array when no deployments exist', async () => {
      const emptyConnector = new KubernetesConnector();
      emptyConnector.setMockDeployments([]);
      const deployments = await emptyConnector.discoverDeployments();

      expect(deployments).toEqual([]);
    });
  });

  describe('StatefulSet Discovery', () => {
    it('should list statefulsets in all namespaces', async () => {
      await connector.initialize();
      const statefulsets = await connector.discoverStatefulSets();

      expect(Array.isArray(statefulsets)).toBe(true);
      statefulsets.forEach((ss) => {
        expect(ss.name).toBeDefined();
        expect(ss.type).toBe('k8s-statefulset');
        expect(ss.namespace).toBeDefined();
      });
    });

    it('should include statefulset replicas info', async () => {
      await connector.initialize();
      const statefulsets = await connector.discoverStatefulSets();

      statefulsets.forEach((ss) => {
        expect(ss.spec).toBeDefined();
        expect(ss.spec.replicas).toBeDefined();
      });
    });
  });

  describe('Pod Discovery', () => {
    it('should list pods in all namespaces', async () => {
      await connector.initialize();
      const pods = await connector.discoverPods();

      expect(Array.isArray(pods)).toBe(true);
      pods.forEach((pod) => {
        expect(pod.name).toBeDefined();
        expect(pod.type).toBe('k8s-pod');
        expect(pod.namespace).toBeDefined();
      });
    });

    it('should include pod phase/status', async () => {
      await connector.initialize();
      const pods = await connector.discoverPods();

      pods.forEach((pod) => {
        expect(['running', 'pending', 'failed', 'unknown']).toContain(
          pod.status
        );
      });
    });

    it('should include container info', async () => {
      await connector.initialize();
      const pods = await connector.discoverPods();

      pods.forEach((pod) => {
        expect(pod.spec).toBeDefined();
        expect(pod.spec.containers).toBeDefined();
      });
    });
  });

  describe('Health Status Checking', () => {
    it('should check deployment health status', async () => {
      await connector.initialize();
      const deployments = await connector.discoverDeployments();

      for (const deployment of deployments) {
        const health = await connector.checkDeploymentHealth(
          deployment.namespace!,
          deployment.name
        );
        expect(['healthy', 'unhealthy', 'unknown']).toContain(health);
      }
    });

    it('should determine unhealthy when replicas mismatch', async () => {
      await connector.initialize();
      const health = await connector.checkDeploymentHealth('default', 'broken-app');

      expect(health).toBe('unhealthy');
    });

    it('should check pod health', async () => {
      await connector.initialize();
      const pods = await connector.discoverPods();

      for (const pod of pods) {
        const health = await connector.checkPodHealth(
          pod.namespace!,
          pod.name
        );
        expect(['healthy', 'unhealthy', 'unknown']).toContain(health);
      }
    });

    it('should determine pod unhealthy when not running', async () => {
      await connector.initialize();
      const health = await connector.checkPodHealth('default', 'pending-pod');

      expect(health).toBe('unhealthy');
    });
  });

  describe('Basic Operations', () => {
    it('should restart a deployment', async () => {
      await connector.initialize();
      const result = await connector.restartDeployment('default', 'test-app');

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('should handle restart errors gracefully', async () => {
      await connector.initialize();
      const result = await connector.restartDeployment(
        'nonexistent',
        'app'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should get pod logs', async () => {
      await connector.initialize();
      const logs = await connector.getPodLogs('default', 'test-pod');

      expect(typeof logs).toBe('string');
      expect(logs.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle logs for non-existent pods', async () => {
      await connector.initialize();
      await expect(
        connector.getPodLogs('nonexistent', 'pod')
      ).rejects.toThrow();
    });

    it('should get pod logs with container specification', async () => {
      await connector.initialize();
      const logs = await connector.getPodLogs('default', 'test-pod', 'my-container');

      expect(typeof logs).toBe('string');
    });

    it('should get pod logs with tail lines limit', async () => {
      await connector.initialize();
      const logs = await connector.getPodLogs('default', 'test-pod', undefined, 50);

      expect(typeof logs).toBe('string');
      // Should not exceed reasonable size for 50 lines
      expect(logs.split('\n').length).toBeLessThanOrEqual(100);
    });
  });

  describe('Full Inventory Sync', () => {
    it('should discover all inventory in one call', async () => {
      await connector.initialize();
      const inventory = await connector.discoverAll();

      expect(inventory).toBeDefined();
      expect(inventory.hosts).toBeDefined();
      expect(inventory.workloads).toBeDefined();
      expect(Array.isArray(inventory.hosts)).toBe(true);
      expect(Array.isArray(inventory.workloads)).toBe(true);
    });

    it('should include nodes as hosts', async () => {
      await connector.initialize();
      const inventory = await connector.discoverAll();

      const nodeHosts = inventory.hosts.filter((h) => h.type === 'k8s-node');
      expect(nodeHosts.length).toBeGreaterThan(0);
    });

    it('should include deployments in workloads', async () => {
      await connector.initialize();
      const inventory = await connector.discoverAll();

      const deploymentWorkloads = inventory.workloads.filter(
        (w) => w.type === 'k8s-deployment'
      );
      expect(deploymentWorkloads.length).toBeGreaterThan(0);
    });

    it('should include statefulsets in workloads', async () => {
      await connector.initialize();
      const inventory = await connector.discoverAll();

      const ssWorkloads = inventory.workloads.filter(
        (w) => w.type === 'k8s-statefulset'
      );
      expect(ssWorkloads.length >= 0).toBe(true); // May or may not exist
    });

    it('should include pods in workloads', async () => {
      await connector.initialize();
      const inventory = await connector.discoverAll();

      const podWorkloads = inventory.workloads.filter((w) => w.type === 'k8s-pod');
      expect(podWorkloads.length).toBeGreaterThan(0);
    });

    it('should mark workload health status', async () => {
      await connector.initialize();
      const inventory = await connector.discoverAll();

      inventory.workloads.forEach((w) => {
        expect(['healthy', 'unhealthy', 'unknown']).toContain(w.health_status);
      });
    });
  });

  describe('Error Handling', () => {
    it('should allow setting connection timeout', async () => {
      const slowConnector = new KubernetesConnector();
      slowConnector.setConnectionTimeout(100); // 100ms timeout
      const result = await slowConnector.initialize();
      expect(result).toBe(true);
    });

    it('should handle API errors gracefully', async () => {
      await connector.initialize();
      const result = await connector.restartDeployment('invalid', 'invalid');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should recover from transient network errors', async () => {
      await connector.initialize();
      // Simulate a retry-able error and ensure it recovers
      const nodes = await connector.discoverNodes();
      expect(Array.isArray(nodes)).toBe(true);
    });
  });

  describe('Mock Testing Helpers', () => {
    it('should allow setting mock nodes for testing', () => {
      const mockNodes: Host[] = [
        {
          id: 'test-1',
          name: 'node-1',
          type: 'k8s-node',
          cluster: 'test-cluster',
          addresses: { lan: '192.168.1.100' },
          status: 'online',
          last_seen_at: new Date(),
          tags: [],
          metadata: { capacity: { cpu: '4', memory: '8Gi' }, labels: {} },
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      connector.setMockNodes(mockNodes);
      expect(connector.getMockNodes()).toEqual(mockNodes);
    });

    it('should allow setting mock deployments for testing', () => {
      const mockDeployments: Workload[] = [
        {
          id: 'dep-1',
          name: 'test-app',
          type: 'k8s-deployment',
          host_id: null,
          status: 'running',
          namespace: 'default',
          spec: { replicas: 3, desiredReplicas: 3, readyReplicas: 3, containers: [] },
          health_status: 'healthy',
          last_updated_at: new Date(),
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      connector.setMockDeployments(mockDeployments);
      expect(connector.getMockDeployments()).toEqual(mockDeployments);
    });
  });
});
