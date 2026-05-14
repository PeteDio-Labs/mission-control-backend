import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';

// ─── Injected DB mock (no mock.module needed) ─────────────────────

const mockQueryMany = mock(() => Promise.resolve([]));
const fakeDb = { queryMany: mockQueryMany };

const { TaskReaper } = await import('../taskReaper.js');

// ─── Tests ────────────────────────────────────────────────────────

describe('TaskReaper', () => {
  let reaper: InstanceType<typeof TaskReaper>;

  beforeEach(() => {
    mockQueryMany.mockClear();
    jest.useFakeTimers();
    reaper = new TaskReaper({}, fakeDb as any);
  });

  afterEach(() => {
    reaper.stop();
    jest.useRealTimers();
  });

  it('returns zeros when no stale rows exist', async () => {
    const result = await reaper.reap();
    expect(result).toEqual({ reaped: 0, expired: 0 });
  });

  it('queries running rows using a stale cutoff timestamp', async () => {
    await reaper.reap();
    expect(mockQueryMany).toHaveBeenCalledWith(
      expect.stringContaining('running'),
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it('cutoff for running tasks is ~30 min ago by default', async () => {
    await reaper.reap();
    const cutoff = new Date(mockQueryMany.mock.calls[0]![1]![0] as string).getTime();
    const expected = Date.now() - 30 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(1000);
  });

  it('cutoff respects custom staleTtlMinutes', async () => {
    reaper = new TaskReaper({ staleTtlMinutes: 10 }, fakeDb as any);
    await reaper.reap();
    const cutoff = new Date(mockQueryMany.mock.calls[0]![1]![0] as string).getTime();
    const expected = Date.now() - 10 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(1000);
  });

  it('returns reaped count for timed-out running tasks', async () => {
    mockQueryMany
      .mockResolvedValueOnce([{ task_id: 'task-1', agent_name: 'ops-investigator' }])
      .mockResolvedValueOnce([]);
    const result = await reaper.reap();
    expect(result.reaped).toBe(1);
  });

  it('queries waiting_approval rows with approval cutoff', async () => {
    await reaper.reap();
    expect(mockQueryMany).toHaveBeenCalledWith(
      expect.stringContaining('waiting_approval'),
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it('returns expired count for stale approval tasks', async () => {
    mockQueryMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ task_id: 'task-2', agent_name: 'knowledge-janitor' }]);
    const result = await reaper.reap();
    expect(result.expired).toBe(1);
  });

  it('reap() fires on interval after start()', async () => {
    reaper.start();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(mockQueryMany).toHaveBeenCalled();
  });

  it('stop() prevents further reap calls', async () => {
    reaper.start();
    reaper.stop();
    jest.advanceTimersByTime(120_000);
    await Promise.resolve(); await Promise.resolve();
    expect(mockQueryMany).not.toHaveBeenCalled();
  });
});
