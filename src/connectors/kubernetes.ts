/**
 * Kubernetes Connector
 * Connects to Kubernetes API and discovers inventory
 */

import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  V1Node,
  V1Deployment,
  V1StatefulSet,
  V1Pod,
  V1Namespace,
} from '@kubernetes/client-node';
import type { Host, Workload, HealthStatus } from '../db/types';
import { logger } from '../utils/logger';
import { kubernetesAvailable, kubernetesRequestDuration } from '../metrics/index';

export interface Inventory {
  hosts: Host[];
  workloads: Workload[];
}

export interface OperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

export class KubernetesConnector {
  private kubeConfig: KubeConfig;
  private coreApi!: CoreV1Api;
  private appsApi!: AppsV1Api;
  private kubeConfigPath?: string;
  private _connectionTimeout: number = 30000; // 30 seconds
  private mockNodes: Host[] | null = null;
  private mockDeployments: Workload[] | null = null;
  private clusterContext: string = '';

  constructor(kubeConfigPath?: string) {
    this.kubeConfigPath = kubeConfigPath;
    this.kubeConfig = new KubeConfig();
  }

  /**
   * Initialize the connector and establish connection to Kubernetes
   */
  async initialize(): Promise<boolean> {
    try {
      if (this._connectionTimeout <= 0) {
        throw new Error('Connection timeout must be positive');
      }

      if (this.kubeConfigPath) {
        this.kubeConfig.loadFromFile(this.kubeConfigPath);
      } else {
        this.kubeConfig.loadFromDefault();
      }

      this.coreApi = this.kubeConfig.makeApiClient(CoreV1Api);
      this.appsApi = this.kubeConfig.makeApiClient(AppsV1Api);

      // Get cluster context
      this.clusterContext = this.kubeConfig.currentContext || 'default';

      logger.info(`Initialized Kubernetes connector for cluster: ${this.clusterContext}`);
      return true;
    } catch (error) {
      logger.error('Failed to initialize Kubernetes connector:', error);
      throw error;
    }
  }

  /**
   * Establish connection to Kubernetes API
   */
  async connect(): Promise<boolean> {
    return Promise.resolve(true); // Already connected in initialize
  }

  /**
   * Get the cluster context name
   */
  getClusterContext(): string {
    return this.clusterContext;
  }

  /**
   * Set connection timeout (for testing)
   */
  setConnectionTimeout(ms: number): void {
    this._connectionTimeout = ms;
  }

  /**
   * Discover all Kubernetes nodes
   */
  async discoverNodes(): Promise<Host[]> {
    if (this.mockNodes !== null) {
      return this.mockNodes;
    }

    const start = Date.now();
    try {
      const response = await this.coreApi.listNode();
      const nodes = response.body.items || [];

      kubernetesRequestDuration.observe((Date.now() - start) / 1000);
      kubernetesAvailable.set(1);
      return nodes.map((node: V1Node) => this.convertNodeToHost(node));
    } catch (error) {
      kubernetesRequestDuration.observe((Date.now() - start) / 1000);
      kubernetesAvailable.set(0);
      logger.error('Failed to discover nodes:', error);
      throw error;
    }
  }

  /**
   * Discover all namespaces
   */
  async discoverNamespaces(): Promise<string[]> {
    try {
      const response = await this.coreApi.listNamespace();
      const namespaces = response.body.items || [];

      // Filter out system namespaces by default
      const excludedNamespaces = ['kube-node-lease', 'kube-public'];

      return namespaces
        .filter((ns: V1Namespace) => !excludedNamespaces.includes(ns.metadata?.name || ''))
        .map((ns: V1Namespace) => ns.metadata?.name || '')
        .filter((name) => name);
    } catch (error) {
      logger.error('Failed to discover namespaces:', error);
      throw error;
    }
  }

  /**
   * Discover all deployments
   */
  async discoverDeployments(): Promise<Workload[]> {
    if (this.mockDeployments !== null) {
      return this.mockDeployments;
    }

    try {
      const namespaces = await this.discoverNamespaces();
      const deployments: Workload[] = [];

      for (const namespace of namespaces) {
        try {
          const response = await this.appsApi.listNamespacedDeployment(namespace);
          const items = response.body.items || [];

          for (const deployment of items) {
            deployments.push(this.convertDeploymentToWorkload(deployment, namespace));
          }
        } catch (error) {
          logger.warn(`Failed to list deployments in namespace ${namespace}:`, error);
        }
      }

      return deployments;
    } catch (error) {
      logger.error('Failed to discover deployments:', error);
      throw error;
    }
  }

  /**
   * Discover all statefulsets
   */
  async discoverStatefulSets(): Promise<Workload[]> {
    try {
      const namespaces = await this.discoverNamespaces();
      const statefulsets: Workload[] = [];

      for (const namespace of namespaces) {
        try {
          const response = await this.appsApi.listNamespacedStatefulSet(namespace);
          const items = response.body.items || [];

          for (const ss of items) {
            statefulsets.push(this.convertStatefulSetToWorkload(ss, namespace));
          }
        } catch (error) {
          logger.warn(`Failed to list statefulsets in namespace ${namespace}:`, error);
        }
      }

      return statefulsets;
    } catch (error) {
      logger.error('Failed to discover statefulsets:', error);
      throw error;
    }
  }

  /**
   * Discover all pods
   */
  async discoverPods(): Promise<Workload[]> {
    try {
      const namespaces = await this.discoverNamespaces();
      const pods: Workload[] = [];

      for (const namespace of namespaces) {
        try {
          const response = await this.coreApi.listNamespacedPod(namespace);
          const items = response.body.items || [];

          for (const pod of items) {
            pods.push(this.convertPodToWorkload(pod, namespace));
          }
        } catch (error) {
          logger.warn(`Failed to list pods in namespace ${namespace}:`, error);
        }
      }

      return pods;
    } catch (error) {
      logger.error('Failed to discover pods:', error);
      throw error;
    }
  }

  /**
   * Check health status of a deployment
   */
  async checkDeploymentHealth(
    namespace: string,
    name: string
  ): Promise<HealthStatus> {
    try {
      const response = await this.appsApi.readNamespacedDeployment(name, namespace);
      const deployment = response.body;

      const desired = deployment.spec?.replicas || 0;
      const ready = deployment.status?.readyReplicas || 0;

      if (desired === 0) {
        return 'unknown';
      }

      if (ready === desired) {
        return 'healthy';
      }

      return 'unhealthy';
    } catch (error) {
      logger.warn(`Failed to check deployment health for ${namespace}/${name}:`, error);
      return 'unknown';
    }
  }

  /**
   * Check health status of a pod
   */
  async checkPodHealth(namespace: string, name: string): Promise<HealthStatus> {
    try {
      const response = await this.coreApi.readNamespacedPod(name, namespace);
      const pod = response.body;

      const phase = pod.status?.phase;

      if (phase === 'Running') {
        return 'healthy';
      } else if (phase === 'Pending' || phase === 'Unknown') {
        return 'unhealthy';
      } else if (phase === 'Failed' || phase === 'CrashLoopBackOff') {
        return 'unhealthy';
      }

      return 'unknown';
    } catch (error) {
      logger.warn(`Failed to check pod health for ${namespace}/${name}:`, error);
      return 'unknown';
    }
  }

  /**
   * Restart a deployment (rolling restart)
   */
  async restartDeployment(namespace: string, name: string): Promise<OperationResult> {
    try {
      const deployment = await this.appsApi.readNamespacedDeployment(name, namespace);

      // Trigger rolling restart by updating annotation
      if (!deployment.body.spec?.template.metadata) {
        throw new Error('Invalid deployment spec');
      }

      deployment.body.spec.template.metadata.annotations =
        deployment.body.spec.template.metadata.annotations || {};
      deployment.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] =
        new Date().toISOString();

      await this.appsApi.patchNamespacedDeployment(
        name,
        namespace,
        deployment.body,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );

      return {
        success: true,
        message: `Successfully restarted deployment ${namespace}/${name}`,
      };
    } catch (error) {
      logger.error(`Failed to restart deployment ${namespace}/${name}:`, error);
      return {
        success: false,
        error: `Failed to restart deployment: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Get logs from a pod
   */
  async getPodLogs(
    namespace: string,
    podName: string,
    container?: string,
    tailLines?: number
  ): Promise<string> {
    try {
      const result = await this.coreApi.readNamespacedPodLog(
        podName,
        namespace,
        container,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tailLines
      );
      return result.body;
    } catch (error) {
      logger.error(`Failed to get pod logs for ${namespace}/${podName}:`, error);
      throw error;
    }
  }

  /**
   * Discover all inventory (nodes and workloads)
   */
  async discoverAll(): Promise<Inventory> {
    try {
      logger.info('Starting full inventory discovery');

      const [nodes, deployments, statefulsets, pods] = await Promise.all([
        this.discoverNodes(),
        this.discoverDeployments(),
        this.discoverStatefulSets(),
        this.discoverPods(),
      ]);

      // Combine all workloads
      const workloads = [...deployments, ...statefulsets, ...pods];

      // Check health status for all workloads
      const workloadsWithHealth = await Promise.all(
        workloads.map(async (workload) => ({
          ...workload,
          health_status:
            workload.type === 'k8s-deployment'
              ? await this.checkDeploymentHealth(
                  workload.namespace!,
                  workload.name
                )
              : workload.type === 'k8s-pod'
                ? await this.checkPodHealth(workload.namespace!, workload.name)
                : 'unknown',
        }))
      );

      logger.info(
        `Discovered ${nodes.length} nodes and ${workloadsWithHealth.length} workloads`
      );

      return {
        hosts: nodes,
        workloads: workloadsWithHealth,
      };
    } catch (error) {
      logger.error('Failed to discover all inventory:', error);
      throw error;
    }
  }

  // ============================================================================
  // CONVERSION HELPERS
  // ============================================================================

  private convertNodeToHost(node: V1Node): Host {
    const addresses = this.extractNodeAddresses(node);

    return {
      id: node.metadata?.uid || '',
      name: node.metadata?.name || '',
      type: 'k8s-node',
      cluster: this.clusterContext,
      addresses,
      status: this.extractNodeStatus(node),
      last_seen_at: new Date(),
      tags: Object.keys(node.metadata?.labels || {}),
      metadata: {
        capacity: node.status?.capacity ? JSON.parse(JSON.stringify(node.status.capacity)) : null,
        allocatable: node.status?.allocatable ? JSON.parse(JSON.stringify(node.status.allocatable)) : null,
        labels: node.metadata?.labels || {},
        taints: JSON.parse(JSON.stringify(node.spec?.taints || [])),
        conditions: JSON.parse(JSON.stringify(node.status?.conditions || [])),
      },
      created_at: node.metadata?.creationTimestamp || new Date(),
      updated_at: new Date(),
    };
  }

  private convertDeploymentToWorkload(deployment: V1Deployment, namespace: string): Workload {
    return {
      id: deployment.metadata?.uid || '',
      name: deployment.metadata?.name || '',
      type: 'k8s-deployment',
      host_id: null,
      status: this.extractDeploymentStatus(deployment),
      namespace,
      spec: {
        replicas: deployment.spec?.replicas || 0,
        desiredReplicas: deployment.spec?.replicas || 0,
        readyReplicas: deployment.status?.readyReplicas || 0,
        updatedReplicas: deployment.status?.updatedReplicas || 0,
        containers:
          deployment.spec?.template.spec?.containers.map((c) => ({
            name: c.name,
            image: c.image || '',
          })) || [],
      },
      health_status: 'unknown',
      last_updated_at: deployment.metadata?.managedFields?.[0]?.time || new Date(),
      metadata: {
        labels: deployment.metadata?.labels || {},
        annotations: deployment.metadata?.annotations || {},
        selector: deployment.spec?.selector?.matchLabels || {},
      },
      created_at: deployment.metadata?.creationTimestamp || new Date(),
      updated_at: new Date(),
    };
  }

  private convertStatefulSetToWorkload(
    statefulset: V1StatefulSet,
    namespace: string
  ): Workload {
    return {
      id: statefulset.metadata?.uid || '',
      name: statefulset.metadata?.name || '',
      type: 'k8s-statefulset',
      host_id: null,
      status: this.extractStatefulSetStatus(statefulset),
      namespace,
      spec: {
        replicas: statefulset.spec?.replicas || 0,
        desiredReplicas: statefulset.spec?.replicas || 0,
        readyReplicas: statefulset.status?.readyReplicas || 0,
        containers:
          statefulset.spec?.template.spec?.containers.map((c) => ({
            name: c.name,
            image: c.image || '',
          })) || [],
      },
      health_status: 'unknown',
      last_updated_at:
        statefulset.metadata?.managedFields?.[0]?.time || new Date(),
      metadata: {
        labels: statefulset.metadata?.labels || {},
        annotations: statefulset.metadata?.annotations || {},
        serviceName: statefulset.spec?.serviceName || null,
      },
      created_at: statefulset.metadata?.creationTimestamp || new Date(),
      updated_at: new Date(),
    };
  }

  private convertPodToWorkload(pod: V1Pod, namespace: string): Workload {
    return {
      id: pod.metadata?.uid || '',
      name: pod.metadata?.name || '',
      type: 'k8s-pod',
      host_id: null,
      status: this.extractPodStatus(pod),
      namespace,
      spec: {
        nodeName: pod.spec?.nodeName || null,
        containers:
          pod.spec?.containers.map((c) => ({
            name: c.name,
            image: c.image || '',
          })) || [],
        restartPolicy: pod.spec?.restartPolicy || null,
      },
      health_status: 'unknown',
      last_updated_at: pod.metadata?.managedFields?.[0]?.time || new Date(),
      metadata: {
        labels: pod.metadata?.labels || {},
        annotations: pod.metadata?.annotations || {},
        ownerReferences: pod.metadata?.ownerReferences ? JSON.parse(JSON.stringify(pod.metadata.ownerReferences)) : null,
      },
      created_at: pod.metadata?.creationTimestamp || new Date(),
      updated_at: new Date(),
    };
  }

  private extractNodeAddresses(node: V1Node): {
    lan?: string;
    public?: string;
    tailscale?: string;
  } {
    const addresses: { lan?: string; public?: string; tailscale?: string } = {};

    node.status?.addresses?.forEach((addr) => {
      if (addr.type === 'InternalIP') {
        addresses.lan = addr.address;
      } else if (addr.type === 'ExternalIP') {
        addresses.public = addr.address;
      } else if (addr.type === 'Hostname') {
        // Could be tailscale or regular hostname
        if (addr.address.includes('tailscale')) {
          addresses.tailscale = addr.address;
        }
      }
    });

    return addresses;
  }

  private extractNodeStatus(node: V1Node): 'online' | 'offline' | 'degraded' | 'unknown' {
    const conditions = node.status?.conditions || [];
    const readyCondition = conditions.find((c) => c.type === 'Ready');

    if (!readyCondition) {
      return 'unknown';
    }

    if (readyCondition.status === 'True') {
      return 'online';
    } else if (readyCondition.status === 'False') {
      return 'offline';
    }

    return 'degraded';
  }

  private extractDeploymentStatus(
    deployment: V1Deployment
  ): 'running' | 'pending' | 'failed' | 'unknown' {
    const desired = deployment.spec?.replicas || 0;
    const ready = deployment.status?.readyReplicas || 0;

    if (desired === 0) {
      return 'unknown';
    }

    if (ready === desired) {
      return 'running';
    } else if (ready === 0) {
      return 'pending';
    }

    return 'unknown';
  }

  private extractStatefulSetStatus(
    statefulset: V1StatefulSet
  ): 'running' | 'pending' | 'failed' | 'unknown' {
    const desired = statefulset.spec?.replicas || 0;
    const ready = statefulset.status?.readyReplicas || 0;

    if (desired === 0) {
      return 'unknown';
    }

    if (ready === desired) {
      return 'running';
    } else if (ready === 0) {
      return 'pending';
    }

    return 'unknown';
  }

  private extractPodStatus(
    pod: V1Pod
  ): 'running' | 'pending' | 'failed' | 'unknown' {
    const phase = pod.status?.phase;

    switch (phase) {
      case 'Running':
        return 'running';
      case 'Pending':
        return 'pending';
      case 'Failed':
      case 'CrashLoopBackOff':
        return 'failed';
      default:
        return 'unknown';
    }
  }

  // ============================================================================
  // TESTING HELPERS
  // ============================================================================

  setMockNodes(nodes: Host[]): void {
    this.mockNodes = nodes;
  }

  getMockNodes(): Host[] | null {
    return this.mockNodes;
  }

  setMockDeployments(deployments: Workload[]): void {
    this.mockDeployments = deployments;
  }

  getMockDeployments(): Workload[] | null {
    return this.mockDeployments;
  }
}
