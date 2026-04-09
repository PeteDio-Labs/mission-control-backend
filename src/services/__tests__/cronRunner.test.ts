import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';

// ─── Module mocks (before dynamic import of module under test) ────
// NOTE: agentDispatcher.js is NOT mocked here — we mock global.fetch instead
// so real dispatch code runs but makes no real HTTP calls. Keeps the module
// registry clean for agentDispatcher.test.ts.

const mockInsertRun = mock(() => Promise.resolve({ task_id: 'mock-id' }));
const mockUpdateStatus = mock(() => Promise.resolve(null));

mock.module('../agentStore.js', () => ({
  insertRun: mockInsertRun,
  updateStatus: mockUpdateStatus,
}));

const { CronRunner } = await import('../cronRunner.js');

// ─── Helpers ─────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── Tests ────────────────────────────────────────────────────────

describe('CronRunner', () => {
  beforeEach(() => {
    mockInsertRun.mockClear();
    // Prevent real HTTP calls during dispatch — agents are unreachable in tests
    global.fetch = mock(() => Promise.resolve(new Response('{"accepted":true}', { status: 200 })));
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires daily-ops-audit after 2h initial delay', () => {
    const runner = new CronRunner();
    runner.start();

    jest.advanceTimersByTime(2 * HOUR);

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'ops-investigator',
        trigger: 'cron',
        input: expect.objectContaining({ focus: 'daily-audit' }),
      }),
    );

    runner.stop();
  });

  it('fires weekly-blog-recap after 5h initial delay', () => {
    const runner = new CronRunner();
    runner.start();

    jest.advanceTimersByTime(5 * HOUR);

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'blog-agent',
        trigger: 'cron',
        input: expect.objectContaining({ contentType: 'weekly-recap' }),
      }),
    );

    runner.stop();
  });

  it('fires weekly-knowledge-audit after 8h initial delay', () => {
    const runner = new CronRunner();
    runner.start();

    jest.advanceTimersByTime(8 * HOUR);

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'knowledge-janitor',
        trigger: 'cron',
        input: expect.objectContaining({ focus: 'staleness-audit' }),
      }),
    );

    runner.stop();
  });

  it('fires daily-ops-audit again after interval', async () => {
    const runner = new CronRunner();
    runner.start();

    // First fire at 2h, second at 2h + 24h
    jest.advanceTimersByTime(2 * HOUR + DAY);
    // Let async dispatch settle
    // Flush the async fire() promise chain (insertRun + dispatchToAgent)
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const opsCalls = mockInsertRun.mock.calls.filter(
      ([p]: [{ agentName: string }]) => p.agentName === 'ops-investigator',
    );
    expect(opsCalls).toHaveLength(2);

    runner.stop();
  });

  it('generates unique taskIds across runs', async () => {
    const runner = new CronRunner();
    runner.start();

    jest.advanceTimersByTime(2 * HOUR + DAY);
    // Flush the async fire() promise chain (insertRun + dispatchToAgent)
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const ids = mockInsertRun.mock.calls
      .filter(([p]: [{ agentName: string }]) => p.agentName === 'ops-investigator')
      .map(([p]: [{ taskId: string }]) => p.taskId);

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    runner.stop();
  });

  it('stop() prevents further timer fires', () => {
    const runner = new CronRunner();
    runner.start();
    runner.stop();

    jest.advanceTimersByTime(10 * HOUR);

    expect(mockInsertRun).not.toHaveBeenCalled();
  });
});
