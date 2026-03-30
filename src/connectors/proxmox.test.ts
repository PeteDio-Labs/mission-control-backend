/**
 * Proxmox Connector Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProxmoxConnector } from './proxmox';

const mockFetch = vi.fn();

function okJson(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    statusText: 'OK',
  });
}

function proxmoxData(data: unknown) {
  return okJson({ data });
}

describe('ProxmoxConnector', () => {
  let connector: ProxmoxConnector;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    connector = new ProxmoxConnector({
      baseUrl: 'https://proxmox.local:8006',
      tokenId: 'user@pve!token',
      tokenSecret: 'secret',
      cluster: 'pve-cluster',
    });

    await connector.initialize();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('initializes the client with expected settings', async () => {
    mockFetch.mockReturnValueOnce(proxmoxData({ version: '8.1.3' }));
    await connector.testConnection();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/version',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'PVEAPIToken=user@pve!token=secret',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('fetches nodes', async () => {
    mockFetch.mockReturnValueOnce(proxmoxData([
      { node: 'pve', status: 'online', maxcpu: 16, maxmem: 1024, maxdisk: 2048 },
    ]));

    const nodes = await connector.getNodes();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/nodes',
      expect.anything(),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].node).toBe('pve');
  });

  it('fetches VMs and LXCs for a node', async () => {
    mockFetch
      .mockReturnValueOnce(proxmoxData([{ vmid: 101, name: 'plex', status: 'running' }]))
      .mockReturnValueOnce(proxmoxData([{ vmid: 201, name: 'pihole', status: 'stopped' }]));

    const vms = await connector.getVMs('pve');
    const lxcs = await connector.getLXCs('pve');

    expect(vms).toHaveLength(1);
    expect(lxcs).toHaveLength(1);
    expect(vms[0].name).toBe('plex');
    expect(lxcs[0].name).toBe('pihole');
  });

  it('discovers inventory with linked host/workloads', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
      if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([{ vmid: 101, name: 'plex', status: 'running' }]);
      if (url.endsWith('/api2/json/nodes/pve/lxc')) return proxmoxData([{ vmid: 201, name: 'pihole', status: 'stopped' }]);
      return proxmoxData([]);
    });

    const inventory = await connector.discoverAll();

    expect(inventory.hosts).toHaveLength(1);
    expect(inventory.workloads).toHaveLength(2);
    expect(inventory.workloads[0].host_id).toBe(inventory.hosts[0].id);
    expect(inventory.workloads[0].type).toBe('proxmox-vm');
    expect(inventory.workloads[1].type).toBe('proxmox-lxc');
  });

  it('sends control commands for VMs and LXCs', async () => {
    mockFetch.mockResolvedValue(proxmoxData({}));

    await connector.startVM('pve', 101);
    await connector.stopVM('pve', 101);
    await connector.restartLXC('pve', 201);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/nodes/pve/qemu/101/status/start',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/nodes/pve/qemu/101/status/stop',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/nodes/pve/lxc/201/status/restart',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('tests connection via /api2/json/version', async () => {
    mockFetch.mockReturnValueOnce(proxmoxData({ version: '8.1.3' }));

    const result = await connector.testConnection();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/version',
      expect.anything(),
    );
  });

  it('returns false when connection test fails', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await connector.testConnection();

    expect(result).toBe(false);
  });

  it('fetches cluster resources', async () => {
    const mockResources = [
      { id: 'node/pve', type: 'node', node: 'pve', status: 'online' },
      { id: 'qemu/101', type: 'qemu', vmid: 101, name: 'plex', node: 'pve' },
    ];
    mockFetch.mockReturnValueOnce(proxmoxData(mockResources));

    const resources = await connector.getClusterResources();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/cluster/resources',
      expect.anything(),
    );
    expect(resources).toHaveLength(2);
  });

  it('fetches cluster resources filtered by type', async () => {
    mockFetch.mockReturnValueOnce(proxmoxData([]));

    await connector.getClusterResources('vm');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxmox.local:8006/api2/json/cluster/resources?type=vm',
      expect.anything(),
    );
  });

  describe('isConfigured', () => {
    it('should return true when all env vars are set', () => {
      process.env.PROXMOX_HOST = 'https://proxmox.local:8006';
      process.env.PROXMOX_TOKEN_ID = 'user@pve!token';
      process.env.PROXMOX_TOKEN_SECRET = 'secret';

      expect(ProxmoxConnector.isConfigured()).toBe(true);

      delete process.env.PROXMOX_HOST;
      delete process.env.PROXMOX_TOKEN_ID;
      delete process.env.PROXMOX_TOKEN_SECRET;
    });

    it('should return false when env vars are missing', () => {
      delete process.env.PROXMOX_HOST;
      delete process.env.PROXMOX_TOKEN_ID;
      delete process.env.PROXMOX_TOKEN_SECRET;

      expect(ProxmoxConnector.isConfigured()).toBe(false);
    });
  });

  describe('LXC Network Address Parsing', () => {
    it('fetches LXC config for a container', async () => {
      mockFetch.mockReturnValueOnce(proxmoxData({
        net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.100/24,gw=192.168.1.1',
        memory: 2048,
        cores: 2,
      }));

      const config = await connector.getLXCConfig('pve', 100);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxmox.local:8006/api2/json/nodes/pve/lxc/100/config',
        expect.anything(),
      );
      expect(config?.net0).toBe('name=eth0,bridge=vmbr0,ip=192.168.1.100/24,gw=192.168.1.1');
    });

    it('returns null when LXC config fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Not found'));

      const config = await connector.getLXCConfig('pve', 999);

      expect(config).toBeNull();
    });

    it('parses network addresses with multiple interfaces', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
        if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([]);
        if (url.endsWith('/api2/json/nodes/pve/lxc')) return proxmoxData([{ vmid: 100, name: 'test-lxc', status: 'running' }]);
        if (url.endsWith('/api2/json/nodes/pve/lxc/100/config')) {
          return proxmoxData({
            net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.100/24,gw=192.168.1.1',
            net1: 'name=eth1,bridge=vmbr1,ip=10.0.0.50/24',
          });
        }
        return proxmoxData([]);
      });

      const inventory = await connector.discoverAll();

      expect(inventory.workloads).toHaveLength(1);
      const lxcWorkload = inventory.workloads[0];
      expect(lxcWorkload.type).toBe('proxmox-lxc');
      expect((lxcWorkload.spec as any).addresses.lan).toBe('192.168.1.100');
      expect((lxcWorkload.spec as any).addresses.net1).toBe('10.0.0.50');
    });

    it('handles DHCP configuration gracefully', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
        if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([]);
        if (url.endsWith('/api2/json/nodes/pve/lxc')) return proxmoxData([{ vmid: 100, name: 'dhcp-lxc', status: 'running' }]);
        if (url.endsWith('/api2/json/nodes/pve/lxc/100/config')) return proxmoxData({ net0: 'name=eth0,bridge=vmbr0,ip=dhcp' });
        return proxmoxData([]);
      });

      const inventory = await connector.discoverAll();
      const lxcWorkload = inventory.workloads[0];
      expect((lxcWorkload.spec as any).addresses).toEqual({});
    });

    it('handles missing network config gracefully', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
        if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([]);
        if (url.endsWith('/api2/json/nodes/pve/lxc')) return proxmoxData([{ vmid: 100, name: 'no-net-lxc', status: 'running' }]);
        if (url.endsWith('/api2/json/nodes/pve/lxc/100/config')) return proxmoxData({ memory: 2048, cores: 2 });
        return proxmoxData([]);
      });

      const inventory = await connector.discoverAll();
      const lxcWorkload = inventory.workloads[0];
      expect((lxcWorkload.spec as any).addresses).toEqual({});
    });

    it('only fetches configs for running LXCs', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
        if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([]);
        if (url.endsWith('/api2/json/nodes/pve/lxc')) {
          return proxmoxData([
            { vmid: 100, name: 'running-lxc', status: 'running' },
            { vmid: 101, name: 'stopped-lxc', status: 'stopped' },
          ]);
        }
        if (url.endsWith('/api2/json/nodes/pve/lxc/100/config')) {
          return proxmoxData({ net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.100/24' });
        }
        return proxmoxData([]);
      });

      await connector.discoverAll();

      const fetchedUrls = mockFetch.mock.calls.map(([url]: [string]) => url);
      expect(fetchedUrls.some(u => u.endsWith('/lxc/100/config'))).toBe(true);
      expect(fetchedUrls.some(u => u.endsWith('/lxc/101/config'))).toBe(false);
    });

    it('strips CIDR notation from IP addresses', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
        if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([]);
        if (url.endsWith('/api2/json/nodes/pve/lxc')) return proxmoxData([{ vmid: 100, name: 'cidr-lxc', status: 'running' }]);
        if (url.endsWith('/api2/json/nodes/pve/lxc/100/config')) {
          return proxmoxData({
            net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.100/24,gw=192.168.1.1',
            net1: 'name=eth1,bridge=vmbr1,ip=10.0.0.50/16',
          });
        }
        return proxmoxData([]);
      });

      const inventory = await connector.discoverAll();
      const lxcWorkload = inventory.workloads[0];
      expect((lxcWorkload.spec as any).addresses.lan).toBe('192.168.1.100');
      expect((lxcWorkload.spec as any).addresses.net1).toBe('10.0.0.50');
    });

    it('includes IP addresses in full discovery flow', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api2/json/nodes')) return proxmoxData([{ node: 'pve', status: 'online' }]);
        if (url.endsWith('/api2/json/nodes/pve/qemu')) return proxmoxData([{ vmid: 101, name: 'vm', status: 'running' }]);
        if (url.endsWith('/api2/json/nodes/pve/lxc')) return proxmoxData([{ vmid: 201, name: 'container', status: 'running' }]);
        if (url.endsWith('/api2/json/nodes/pve/lxc/201/config')) {
          return proxmoxData({ net0: 'name=eth0,bridge=vmbr0,ip=192.168.1.201/24,gw=192.168.1.1' });
        }
        return proxmoxData([]);
      });

      const inventory = await connector.discoverAll();

      expect(inventory.hosts).toHaveLength(1);
      expect(inventory.workloads).toHaveLength(2);

      const lxcWorkload = inventory.workloads.find(w => w.type === 'proxmox-lxc');
      expect(lxcWorkload).toBeDefined();
      expect((lxcWorkload?.spec as any).addresses).toEqual({ lan: '192.168.1.201' });
    });
  });
});
