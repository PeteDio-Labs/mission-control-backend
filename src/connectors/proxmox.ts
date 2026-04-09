/**
 * Proxmox Connector
 * Connects to Proxmox API and discovers inventory
 */

import crypto from 'crypto';
import type { Host, HostStatus, Workload, WorkloadStatus } from '../db/types';
import { logger } from '../utils/logger';
import { proxmoxAvailable, proxmoxRequestDuration } from '../metrics/index';

export interface ProxmoxNode {
  node: string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  uptime?: number;
  [key: string]: unknown;
}

export interface ProxmoxVM {
  vmid: number;
  name?: string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  uptime?: number;
  [key: string]: unknown;
}

export interface ProxmoxLXC {
  vmid: number;
  name?: string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  uptime?: number;
  [key: string]: unknown;
}

export interface ProxmoxNodeStatus {
  uptime?: number;
  cpu?: number;
  maxcpu?: number;
  loadavg?: number[];
  memory?: {
    total?: number;
    used?: number;
    free?: number;
  };
  swap?: {
    total?: number;
    used?: number;
    free?: number;
  };
  rootfs?: {
    total?: number;
    used?: number;
    free?: number;
  };
  [key: string]: unknown;
}

export interface Inventory {
  hosts: Host[];
  workloads: Workload[];
}

export interface ProxmoxClusterResource {
  id: string;
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn';
  node?: string;
  vmid?: number;
  name?: string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  uptime?: number;
  template?: number;
  [key: string]: unknown;
}

export interface ProxmoxLXCConfig {
  net0?: string;
  net1?: string;
  net2?: string;
  [key: string]: unknown;
}

export interface NetworkAddresses {
  lan?: string;
  public?: string;
  [key: string]: string | undefined;
}

export interface ProxmoxConnectorOptions {
  baseUrl?: string;
  tokenId?: string;
  tokenSecret?: string;
  cluster?: string;
  timeoutMs?: number;
}

export class ProxmoxConnector {
  private initialized = false;
  private baseUrl: string;
  private tokenId: string;
  private tokenSecret: string;
  private cluster: string;
  private connectionTimeout: number = 20000;

  constructor(options?: ProxmoxConnectorOptions) {
    this.baseUrl = options?.baseUrl ?? process.env.PROXMOX_HOST ?? '';
    this.tokenId = options?.tokenId ?? process.env.PROXMOX_TOKEN_ID ?? '';
    this.tokenSecret = options?.tokenSecret ?? process.env.PROXMOX_TOKEN_SECRET ?? '';
    this.cluster = options?.cluster ?? this.deriveClusterName(this.baseUrl);

    if (options?.timeoutMs) {
      this.connectionTimeout = options.timeoutMs;
    }
  }

  async initialize(): Promise<boolean> {
    if (!this.baseUrl) throw new Error('PROXMOX_HOST is required');
    if (!this.tokenId || !this.tokenSecret) {
      throw new Error('PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET are required');
    }

    this.initialized = true;

    logger.info('Initialized Proxmox connector', {
      baseUrl: this.baseUrl,
      cluster: this.cluster,
    });

    return true;
  }

  async testConnection(): Promise<boolean> {
    const start = Date.now();
    try {
      this.ensureInitialized();
      await this.request('/api2/json/version');
      proxmoxRequestDuration.observe((Date.now() - start) / 1000);
      proxmoxAvailable.set(1);
      logger.info('Proxmox connection test successful');
      return true;
    } catch (error) {
      proxmoxRequestDuration.observe((Date.now() - start) / 1000);
      proxmoxAvailable.set(0);
      logger.error('Proxmox connection test failed', { error });
      return false;
    }
  }

  setConnectionTimeout(ms: number): void {
    this.connectionTimeout = ms;
  }

  /**
   * Get all cluster resources in a single call
   */
  async getClusterResources(type?: 'node' | 'vm' | 'storage'): Promise<ProxmoxClusterResource[]> {
    this.ensureInitialized();
    const params = type ? `?type=${encodeURIComponent(type)}` : '';
    const data = await this.request<{ data: ProxmoxClusterResource[] }>(`/api2/json/cluster/resources${params}`);
    return data.data ?? [];
  }

  async getNodes(): Promise<ProxmoxNode[]> {
    this.ensureInitialized();
    const start = Date.now();
    try {
      const data = await this.request<{ data: ProxmoxNode[] }>('/api2/json/nodes');
      proxmoxRequestDuration.observe((Date.now() - start) / 1000);
      proxmoxAvailable.set(1);
      return data.data ?? [];
    } catch (error) {
      proxmoxRequestDuration.observe((Date.now() - start) / 1000);
      proxmoxAvailable.set(0);
      throw error;
    }
  }

  async getVMs(node: string): Promise<ProxmoxVM[]> {
    this.ensureInitialized();
    const data = await this.request<{ data: ProxmoxVM[] }>(`/api2/json/nodes/${node}/qemu`);
    return data.data ?? [];
  }

  async getLXCs(node: string): Promise<ProxmoxLXC[]> {
    this.ensureInitialized();
    const data = await this.request<{ data: ProxmoxLXC[] }>(`/api2/json/nodes/${node}/lxc`);
    return data.data ?? [];
  }

  async getLXCConfig(node: string, vmid: number): Promise<ProxmoxLXCConfig | null> {
    try {
      this.ensureInitialized();
      const data = await this.request<{ data: ProxmoxLXCConfig }>(`/api2/json/nodes/${node}/lxc/${vmid}/config`);
      return data.data ?? null;
    } catch (error) {
      logger.warn(`Failed to fetch LXC config for ${vmid} on ${node}`, { error });
      return null;
    }
  }

  async getNodeStatus(node: string): Promise<ProxmoxNodeStatus> {
    this.ensureInitialized();
    const data = await this.request<{ data: ProxmoxNodeStatus }>(`/api2/json/nodes/${node}/status`);
    return data.data ?? {};
  }

  async startVM(node: string, vmid: number): Promise<string> {
    this.ensureInitialized();
    await this.request(`/api2/json/nodes/${node}/qemu/${vmid}/status/start`, 'POST');
    return `Start request sent for VM ${vmid} on ${node}`;
  }

  async stopVM(node: string, vmid: number): Promise<string> {
    this.ensureInitialized();
    await this.request(`/api2/json/nodes/${node}/qemu/${vmid}/status/stop`, 'POST');
    return `Stop request sent for VM ${vmid} on ${node}`;
  }

  async restartLXC(node: string, vmid: number): Promise<string> {
    this.ensureInitialized();
    await this.request(`/api2/json/nodes/${node}/lxc/${vmid}/status/restart`, 'POST');
    return `Restart request sent for LXC ${vmid} on ${node}`;
  }

  async startLXC(node: string, vmid: number): Promise<string> {
    this.ensureInitialized();
    await this.request(`/api2/json/nodes/${node}/lxc/${vmid}/status/start`, 'POST');
    return `Start request sent for LXC ${vmid} on ${node}`;
  }

  async stopLXC(node: string, vmid: number): Promise<string> {
    this.ensureInitialized();
    await this.request(`/api2/json/nodes/${node}/lxc/${vmid}/status/stop`, 'POST');
    return `Stop request sent for LXC ${vmid} on ${node}`;
  }

  async restartVM(node: string, vmid: number): Promise<string> {
    this.ensureInitialized();
    await this.request(`/api2/json/nodes/${node}/qemu/${vmid}/status/reboot`, 'POST');
    return `Restart request sent for VM ${vmid} on ${node}`;
  }

  static isConfigured(): boolean {
    return !!(
      process.env.PROXMOX_HOST &&
      process.env.PROXMOX_TOKEN_ID &&
      process.env.PROXMOX_TOKEN_SECRET
    );
  }

  async discoverAll(): Promise<Inventory> {
    const nodes = await this.getNodes();
    const hosts = nodes.map((node) => this.convertNodeToHost(node));

    const workloads: Workload[] = [];

    for (const node of nodes) {
      const [vms, lxcs] = await Promise.all([
        this.getVMs(node.node),
        this.getLXCs(node.node),
      ]);

      const hostId = this.getHostId(node.node);

      // Fetch LXC configs for running containers in parallel
      const runningLxcs = lxcs.filter(lxc => lxc.status === 'running');
      const lxcConfigs = await Promise.all(
        runningLxcs.map(lxc => this.getLXCConfig(node.node, lxc.vmid))
      );
      const configMap = new Map(
        runningLxcs.map((lxc, idx) => [lxc.vmid, lxcConfigs[idx]])
      );

      workloads.push(
        ...vms.map((vm) => this.convertVMToWorkload(vm, node.node, hostId)),
        ...lxcs.map((lxc) =>
          this.convertLXCToWorkload(lxc, node.node, hostId, configMap.get(lxc.vmid))
        )
      );
    }

    return { hosts, workloads };
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private async request<T = unknown>(path: string, method = 'GET'): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(this.connectionTimeout),
      // @ts-ignore - Bun specific fetch option in CI vs local types
      tls: { rejectUnauthorized: false },
    });

    if (!response.ok) {
      throw new Error(`Proxmox API error: HTTP ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Proxmox connector not initialized');
    }
  }

  private convertNodeToHost(node: ProxmoxNode): Host {
    const now = new Date();
    return {
      id: this.getHostId(node.node),
      name: node.node,
      type: 'proxmox-node',
      cluster: this.cluster,
      addresses: {},
      status: this.mapNodeStatus(node.status),
      last_seen_at: now,
      tags: ['proxmox'],
      metadata: {
        cpu: node.cpu ?? null,
        maxcpu: node.maxcpu ?? null,
        mem: node.mem ?? null,
        maxmem: node.maxmem ?? null,
        disk: node.disk ?? null,
        maxdisk: node.maxdisk ?? null,
        uptime: node.uptime ?? null,
      },
      created_at: now,
      updated_at: now,
    };
  }

  private convertVMToWorkload(vm: ProxmoxVM, node: string, hostId: string): Workload {
    const now = new Date();
    return {
      id: this.getWorkloadId(`proxmox-vm:${node}:${vm.vmid}`),
      name: vm.name || `vm-${vm.vmid}`,
      type: 'proxmox-vm',
      host_id: hostId,
      status: this.mapWorkloadStatus(vm.status),
      namespace: node,
      spec: {
        vmid: vm.vmid,
        node,
        cpu: vm.cpu ?? null,
        maxcpu: vm.maxcpu ?? null,
        mem: vm.mem ?? null,
        maxmem: vm.maxmem ?? null,
        disk: vm.disk ?? null,
        maxdisk: vm.maxdisk ?? null,
        uptime: vm.uptime ?? null,
      },
      health_status: vm.status === 'running' ? 'healthy' : 'unknown',
      last_updated_at: now,
      metadata: { node },
      created_at: now,
      updated_at: now,
    };
  }

  private convertLXCToWorkload(
    lxc: ProxmoxLXC,
    node: string,
    hostId: string,
    config?: ProxmoxLXCConfig | null
  ): Workload {
    const now = new Date();
    const addresses = this.parseNetworkAddresses(config ?? null);

    const addressesJson: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(addresses)) {
      if (value !== undefined) {
        addressesJson[key] = value;
      }
    }

    return {
      id: this.getWorkloadId(`proxmox-lxc:${node}:${lxc.vmid}`),
      name: lxc.name || `lxc-${lxc.vmid}`,
      type: 'proxmox-lxc',
      host_id: hostId,
      status: this.mapWorkloadStatus(lxc.status),
      namespace: node,
      spec: {
        vmid: lxc.vmid,
        node,
        cpu: lxc.cpu ?? null,
        maxcpu: lxc.maxcpu ?? null,
        mem: lxc.mem ?? null,
        maxmem: lxc.maxmem ?? null,
        disk: lxc.disk ?? null,
        maxdisk: lxc.maxdisk ?? null,
        uptime: lxc.uptime ?? null,
        addresses: addressesJson,
      },
      health_status: lxc.status === 'running' ? 'healthy' : 'unknown',
      last_updated_at: now,
      metadata: { node },
      created_at: now,
      updated_at: now,
    };
  }

  private parseNetworkAddresses(config: ProxmoxLXCConfig | null): NetworkAddresses {
    const addresses: NetworkAddresses = {};
    if (!config) return addresses;

    const netKeys = Object.keys(config)
      .filter(key => /^net\d+$/.test(key))
      .sort();

    for (const netKey of netKeys) {
      const netConfig = config[netKey];
      if (typeof netConfig !== 'string') continue;

      const parts = netConfig.split(',');
      const configMap: Record<string, string> = {};
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key && value) configMap[key.trim()] = value.trim();
      }

      const ip = configMap['ip'];
      if (!ip || ip.toLowerCase() === 'dhcp') continue;

      const cleanIp = ip.split('/')[0];
      if (netKey === 'net0') {
        addresses.lan = cleanIp;
      } else {
        addresses[netKey] = cleanIp;
      }
    }

    return addresses;
  }

  private mapNodeStatus(status?: string): HostStatus {
    if (status === 'online') return 'online';
    if (status === 'offline') return 'offline';
    return 'unknown';
  }

  private mapWorkloadStatus(status?: string): WorkloadStatus {
    switch (status) {
      case 'running': return 'running';
      case 'stopped':
      case 'paused':
      case 'suspended': return 'stopped';
      default: return 'unknown';
    }
  }

  private getHostId(nodeName: string): string {
    return this.getDeterministicId(`proxmox-node:${this.cluster}:${nodeName}`);
  }

  private getWorkloadId(seed: string): string {
    return this.getDeterministicId(seed);
  }

  private getDeterministicId(seed: string): string {
    const hash = crypto.createHash('sha1').update(seed).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private deriveClusterName(baseUrl: string): string {
    try {
      if (!baseUrl) return 'proxmox';
      return new URL(baseUrl).hostname || 'proxmox';
    } catch {
      return 'proxmox';
    }
  }
}
