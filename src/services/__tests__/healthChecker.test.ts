import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import type { AgentDefinition } from '../../config/agents.js';

const { HealthChecker } = await import('../healthChecker.js');

// ─── Fixtures ─────────────────────────────────────────────────────

const agents: AgentDefinition[] = [
  { name: 'ops-investigator', url: 'http://192.168.50.113:3005', description: 'test' },
  { name: 'knowledge-janitor', url: 'http://192.168.50.113:3007', description: 'test' },
];

// ─── Tests ────────────────────────────────────────────────────────

describe('HealthChecker', () => {
  let mockFetch: ReturnType<typeof mock>;
  let mockNotify: ReturnType<typeof mock>;
  let checker: InstanceType<typeof HealthChecker>;

  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('ok', { status: 200 })));
    mockNotify = mock(() => Promise.resolve(undefined));
    jest.useFakeTimers();
    checker = new HealthChecker(agents, { intervalMs: 1000 }, mockFetch, mockNotify);
  });

  afterEach(() => {
    checker.stop();
    jest.useRealTimers();
  });

  it('marks agent ok when /health returns 200', async () => {
    await checker.check();
    expect(checker.getHealth('ops-investigator')?.status).toBe('ok');
  });

  it('marks agent unreachable when /health returns non-2xx', async () => {
    mockFetch.mockResolvedValue(new Response('error', { status: 503 }));
    await checker.check();
    expect(checker.getHealth('ops-investigator')?.status).toBe('unreachable');
  });

  it('marks agent unreachable when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await checker.check();
    expect(checker.getHealth('ops-investigator')?.status).toBe('unreachable');
  });

  it('GETs {url}/health for each agent', async () => {
    await checker.check();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.50.113:3005/health',
      expect.anything(),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.50.113:3007/health',
      expect.anything(),
    );
  });

  it('sends notify on ok → unreachable transition', async () => {
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    await checker.check(); // establishes ok baseline
    mockFetch.mockRejectedValue(new Error('down'));
    await checker.check();
    expect(mockNotify).toHaveBeenCalledWith('ops-investigator', 'unreachable');
  });

  it('does not notify when already unreachable (no transition)', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    await checker.check();
    mockNotify.mockClear();
    await checker.check();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('sends notify on unreachable → ok recovery', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    await checker.check();
    mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
    await checker.check();
    expect(mockNotify).toHaveBeenCalledWith('ops-investigator', 'ok');
  });

  it('does not notify on first check (no prior state)', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    await checker.check();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('getHealth() returns undefined before first check', () => {
    expect(checker.getHealth('ops-investigator')).toBeUndefined();
  });

  it('getAllHealth() returns state for all agents after check', async () => {
    await checker.check();
    const health = checker.getAllHealth();
    expect(Object.keys(health)).toContain('ops-investigator');
    expect(Object.keys(health)).toContain('knowledge-janitor');
  });

  it('check() stores checkedAt timestamp', async () => {
    await checker.check();
    expect(checker.getHealth('ops-investigator')?.checkedAt).toBeDefined();
  });

  it('polls on interval after start()', async () => {
    checker.start();
    jest.advanceTimersByTime(1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('stop() prevents further polling', async () => {
    checker.start();
    checker.stop();
    mockFetch.mockClear();
    jest.advanceTimersByTime(5000);
    await Promise.resolve(); await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('start() is idempotent', async () => {
    checker.start();
    checker.start();
    mockFetch.mockClear();
    jest.advanceTimersByTime(1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Only 1 interval fires, not 2
    expect(mockFetch).toHaveBeenCalledTimes(agents.length);
  });
});
