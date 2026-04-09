import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { EventEmitter } from 'events';
import type { InfraEvent } from '@petedio/shared';

// ─── Controllable eventBus ────────────────────────────────────────
// Create a real EventEmitter and expose it so tests can emit events.

const testEventBus = new EventEmitter();
testEventBus.setMaxListeners(50);

mock.module('../../api/routes/events.js', () => ({ eventBus: testEventBus }));

// ─── Module mocks ─────────────────────────────────────────────────
// agentDispatcher.js is NOT mocked — we mock global.fetch instead so the
// real dispatcher runs but makes no real HTTP calls. This keeps agentDispatcher.js
// un-mocked in the module registry so agentDispatcher.test.ts can test it.

const mockInsertRun = mock(() => Promise.resolve({ task_id: 'mock-id' }));
const mockUpdateStatus = mock(() => Promise.resolve(null));

mock.module('../agentStore.js', () => ({
  insertRun: mockInsertRun,
  updateStatus: mockUpdateStatus,
}));

const { EventRouter } = await import('../eventRouter.js');

// ─── Fixtures ─────────────────────────────────────────────────────

function makeEvent(overrides: Partial<InfraEvent> = {}): InfraEvent {
  return {
    source: 'kubernetes',
    type: 'pod-failure',
    severity: 'warning',
    message: 'Pod crashed',
    timestamp: new Date().toISOString(),
    affected_service: 'blog-agent',
    namespace: 'blog-dev',
    metadata: {},
    ...overrides,
  };
}

// Emit an event and flush the microtask queue so the async route() resolves
async function emit(event: InfraEvent): Promise<void> {
  testEventBus.emit('event', event);
  await new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ────────────────────────────────────────────────────────

describe('EventRouter', () => {
  let router: InstanceType<typeof EventRouter>;

  beforeEach(() => {
    mockInsertRun.mockClear();
    mockUpdateStatus.mockClear();
    // Prevent real HTTP calls from the dispatcher (fire-and-forget via setImmediate)
    global.fetch = mock(() => Promise.resolve(new Response('{"accepted":true}', { status: 200 })));
    router = new EventRouter();
    router.start();
  });

  afterEach(() => {
    router.stop();
  });

  it('routes pod-failure to ops-investigator', async () => {
    await emit(makeEvent({ source: 'kubernetes', type: 'pod-failure' }));

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'ops-investigator',
        trigger: 'infra-event',
        input: expect.objectContaining({ focus: 'pod-failure' }),
      }),
    );
  });

  it('routes critical severity to ops-investigator', async () => {
    await emit(makeEvent({ severity: 'critical', source: 'prometheus', type: 'alert' }));

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'ops-investigator',
        input: expect.objectContaining({ focus: 'incident' }),
      }),
    );
  });

  it('routes k8s deployment info event to blog-agent', async () => {
    await emit(makeEvent({ source: 'kubernetes', type: 'deployment', severity: 'info' }));

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'blog-agent', trigger: 'infra-event' }),
    );
  });

  it('routes argocd sync-drift to ops-investigator', async () => {
    await emit(makeEvent({ source: 'argocd', type: 'sync-drift', severity: 'warning' }));

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'ops-investigator',
        input: expect.objectContaining({ focus: 'sync-drift' }),
      }),
    );
  });

  it('ignores events that match no rules', async () => {
    await emit(makeEvent({ source: 'proxmox', type: 'storage', severity: 'info' }));

    expect(mockInsertRun).not.toHaveBeenCalled();
  });

  it('enforces cooldown — second event within window is dropped', async () => {
    const event = makeEvent({ source: 'kubernetes', type: 'pod-failure' });

    await emit(event);
    expect(mockInsertRun).toHaveBeenCalledTimes(1);

    await emit(event);
    expect(mockInsertRun).toHaveBeenCalledTimes(1);
  });

  it('fires again after cooldown window expires', async () => {
    const event = makeEvent({ source: 'kubernetes', type: 'pod-failure' });

    await emit(event);
    expect(mockInsertRun).toHaveBeenCalledTimes(1);

    // Advance wall-clock time by manipulating Date to simulate cooldown expiry.
    // The cooldown tracker uses Date.now() so we replace it temporarily.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60 * 1000 + 1;
    await emit(event);
    Date.now = realNow;

    expect(mockInsertRun).toHaveBeenCalledTimes(2);
  });

  it('stop() removes listener — no dispatch after stop', async () => {
    router.stop();

    await emit(makeEvent({ source: 'kubernetes', type: 'pod-failure' }));

    expect(mockInsertRun).not.toHaveBeenCalled();
  });

  it('start() is idempotent — second call does not double-dispatch', async () => {
    router.start(); // second call — should be no-op

    await emit(makeEvent({ source: 'kubernetes', type: 'pod-failure' }));

    expect(mockInsertRun).toHaveBeenCalledTimes(1);
  });
});
