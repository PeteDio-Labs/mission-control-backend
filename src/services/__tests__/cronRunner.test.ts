import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';

const { CronRunner } = await import('../cronRunner.js');

// ─── Helpers ─────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── Tests ────────────────────────────────────────────────────────

describe('CronRunner', () => {
  let mockEnqueue: ReturnType<typeof mock>;
  let mockQueue: { enqueue: ReturnType<typeof mock>; start: () => void; stop: () => void };

  beforeEach(() => {
    mockEnqueue = mock(() => Promise.resolve(undefined));
    mockQueue = { enqueue: mockEnqueue, start: () => {}, stop: () => {} };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('enqueues daily-ops-audit after 2h initial delay', () => {
    const runner = new CronRunner(mockQueue as any);
    runner.start();

    jest.advanceTimersByTime(2 * HOUR);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'ops-investigator',
        trigger: 'cron',
        input: expect.objectContaining({ focus: 'daily-audit' }),
      }),
      expect.objectContaining({ priority: 5 }),
    );

    runner.stop();
  });

  it('enqueues weekly-blog-recap after 5h initial delay', () => {
    const runner = new CronRunner(mockQueue as any);
    runner.start();

    jest.advanceTimersByTime(5 * HOUR);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'blog-agent',
        trigger: 'cron',
        input: expect.objectContaining({ contentType: 'weekly-recap' }),
      }),
      expect.objectContaining({ priority: 5 }),
    );

    runner.stop();
  });

  it('enqueues weekly-knowledge-audit after 8h initial delay', () => {
    const runner = new CronRunner(mockQueue as any);
    runner.start();

    jest.advanceTimersByTime(8 * HOUR);

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'knowledge-janitor',
        trigger: 'cron',
        input: expect.objectContaining({ focus: 'staleness-audit' }),
      }),
      expect.objectContaining({ priority: 5 }),
    );

    runner.stop();
  });

  it('fires daily-ops-audit again after interval', async () => {
    const runner = new CronRunner(mockQueue as any);
    runner.start();

    jest.advanceTimersByTime(2 * HOUR + DAY);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const opsCalls = mockEnqueue.mock.calls.filter(
      ([p]: [{ agentName: string }]) => p.agentName === 'ops-investigator',
    );
    expect(opsCalls).toHaveLength(2);

    runner.stop();
  });

  it('generates unique taskIds across runs', async () => {
    const runner = new CronRunner(mockQueue as any);
    runner.start();

    jest.advanceTimersByTime(2 * HOUR + DAY);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const ids = mockEnqueue.mock.calls
      .filter(([p]: [{ agentName: string }]) => p.agentName === 'ops-investigator')
      .map(([p]: [{ taskId: string }]) => p.taskId);

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    runner.stop();
  });

  it('stop() prevents further timer fires', () => {
    const runner = new CronRunner(mockQueue as any);
    runner.start();
    runner.stop();

    jest.advanceTimersByTime(10 * HOUR);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
