import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ─── Module mocks (before dynamic import of module under test) ────

const mockUpdateStatus = mock(() => Promise.resolve(null));
const mockGetAgent = mock(() => undefined as ReturnType<typeof import('../../config/agents.js').getAgent>);

mock.module('../../config/agents.js', () => ({ getAgent: mockGetAgent }));
mock.module('../agentStore.js', () => ({ updateStatus: mockUpdateStatus }));

const { dispatchToAgent } = await import('../agentDispatcher.js');

// ─── Fixtures ─────────────────────────────────────────────────────

const basePayload = {
  taskId: 'task-123',
  agentName: 'ops-investigator',
  trigger: 'manual' as const,
  input: { focus: 'test' },
  issuedAt: new Date().toISOString(),
};

const mockAgent = {
  name: 'ops-investigator',
  url: 'http://192.168.50.113:3005',
  description: 'test agent',
};

// ─── Tests ────────────────────────────────────────────────────────

describe('dispatchToAgent', () => {
  beforeEach(() => {
    mockUpdateStatus.mockClear();
    mockGetAgent.mockClear();
    // Reset fetch to a no-op so tests that don't care about it don't fail
    global.fetch = mock(() => Promise.resolve(new Response('{"accepted":true}', { status: 200 })));
  });

  it('marks run failed when agent is not registered', async () => {
    mockGetAgent.mockReturnValue(undefined);

    await dispatchToAgent(basePayload);

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-123',
        status: 'failed',
        message: expect.stringContaining('No agent registered'),
      }),
    );
  });

  it('POSTs task payload to {url}/run', async () => {
    mockGetAgent.mockReturnValue(mockAgent);
    const mockFetch = mock(() => Promise.resolve(new Response('ok', { status: 200 })));
    global.fetch = mockFetch;

    await dispatchToAgent(basePayload);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://192.168.50.113:3005/run',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basePayload),
      }),
    );
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('marks run failed when agent returns non-2xx', async () => {
    mockGetAgent.mockReturnValue(mockAgent);
    global.fetch = mock(() => Promise.resolve(new Response('service unavailable', { status: 503 })));

    await dispatchToAgent(basePayload);

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-123',
        status: 'failed',
        message: expect.stringContaining('503'),
      }),
    );
  });

  it('marks run failed on network error', async () => {
    mockGetAgent.mockReturnValue(mockAgent);
    global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

    await dispatchToAgent(basePayload);

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-123',
        status: 'failed',
        message: expect.stringContaining('ECONNREFUSED'),
      }),
    );
  });
});
