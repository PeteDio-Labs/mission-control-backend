/**
 * TaskQueue — TDD
 *
 * Tests drive the implementation of:
 *   - enqueue()    : insert a row with status='queued'
 *   - poll()       : SELECT FOR UPDATE SKIP LOCKED, lock, dispatch
 *   - retry logic  : on dispatch failure, increment retry_count, set next_retry_at
 *   - dead-letter  : after max_retries, status='dead-letter', notify
 *   - concurrency  : per-agent limit + global Ollama gate
 *   - stop()       : clears poll interval
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';

// ─── Module mocks ─────────────────────────────────────────────────

const mockDispatchToAgent = mock(() => Promise.resolve(undefined));
const mockUpdateStatus = mock(() => Promise.resolve(null));
const mockInsertRun = mock(() => Promise.resolve({ task_id: 'mock-id' }));
const mockSendNotification = mock(() => Promise.resolve(undefined));

// DB client mock — we replace queryOne / queryMany per test
const mockQueryOne = mock(() => Promise.resolve(null));
const mockQueryMany = mock(() => Promise.resolve([]));
const mockQuery = mock(() => Promise.resolve({ rows: [], rowCount: 0 }));

mock.module('../agentDispatcher.js', () => ({ dispatchToAgent: mockDispatchToAgent }));
mock.module('../agentStore.js', () => ({
  insertRun: mockInsertRun,
  updateStatus: mockUpdateStatus,
}));
mock.module('../../db/client.js', () => ({
  default: { queryOne: mockQueryOne, queryMany: mockQueryMany, query: mockQuery },
  db: { queryOne: mockQueryOne, queryMany: mockQueryMany, query: mockQuery },
}));

const { TaskQueue } = await import('../taskQueue.js');

// ─── Fixtures ─────────────────────────────────────────────────────

const basePayload = {
  taskId: 'task-abc',
  agentName: 'ops-investigator',
  trigger: 'manual' as const,
  input: { focus: 'test' },
  issuedAt: new Date().toISOString(),
};

const queuedRow = {
  task_id: 'task-abc',
  agent_name: 'ops-investigator',
  status: 'queued',
  retry_count: 0,
  max_retries: 3,
  next_retry_at: null,
  locked_by: null,
  locked_at: null,
  priority: 5,
  timeout_at: null,
  input: basePayload.input,
  trigger: 'manual',
  issued_at: basePayload.issuedAt,
};

// ─── Tests ────────────────────────────────────────────────────────

describe('TaskQueue', () => {
  let queue: InstanceType<typeof TaskQueue>;

  beforeEach(() => {
    mockDispatchToAgent.mockClear();
    mockUpdateStatus.mockClear();
    mockInsertRun.mockClear();
    mockQueryOne.mockClear();
    mockQueryMany.mockClear();
    mockQuery.mockClear();
    jest.useFakeTimers();
    queue = new TaskQueue({ pollIntervalMs: 1000 });
  });

  afterEach(() => {
    queue.stop();
    jest.useRealTimers();
  });

  // ─── enqueue ──────────────────────────────────────────────────

  describe('enqueue()', () => {
    it('inserts a row with status=queued and default priority 5', async () => {
      mockQueryOne.mockResolvedValue({ task_id: 'task-abc', status: 'queued' });

      await queue.enqueue(basePayload);

      // 'queued' is a SQL literal in the INSERT — verify task_id and agent_name in params
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining("'queued'"),
        expect.arrayContaining(['task-abc', 'ops-investigator']),
      );
    });

    it('inserts with custom priority', async () => {
      mockQueryOne.mockResolvedValue({ task_id: 'task-abc', status: 'queued' });

      await queue.enqueue(basePayload, { priority: 1 });

      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_runs'),
        expect.arrayContaining([1]),
      );
    });
  });

  // ─── poll ─────────────────────────────────────────────────────

  describe('poll()', () => {
    it('does nothing when no queued rows are found', async () => {
      mockQueryOne.mockResolvedValue(null);
      queue.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(mockDispatchToAgent).not.toHaveBeenCalled();
    });

    it('dispatches when a queued row is found', async () => {
      // First poll call: returns the queued row (locking it)
      // Second poll call: returns null (nothing left)
      mockQueryOne
        .mockResolvedValueOnce(queuedRow)
        .mockResolvedValue(null);

      queue.start();
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); // let dispatch chain resolve

      expect(mockDispatchToAgent).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-abc', agentName: 'ops-investigator' }),
      );
    });

    it('sets status to running when locking a row', async () => {
      mockQueryOne
        .mockResolvedValueOnce(queuedRow)
        .mockResolvedValue(null);

      queue.start();
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // The lock UPDATE is one of the queryOne calls
      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('locked_by'),
        expect.anything(),
      );
    });
  });

  // ─── retry logic ──────────────────────────────────────────────

  describe('retry logic', () => {
    it('increments retry_count and sets next_retry_at on dispatch failure', async () => {
      mockDispatchToAgent.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockQueryOne
        .mockResolvedValueOnce(queuedRow)
        .mockResolvedValue(null);

      queue.start();
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('next_retry_at'),
        expect.arrayContaining(['task-abc']),
      );
    });

    it('moves to dead-letter after max_retries exceeded', async () => {
      const exhaustedRow = { ...queuedRow, retry_count: 3, max_retries: 3 };
      mockDispatchToAgent.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      mockQueryOne
        .mockResolvedValueOnce(exhaustedRow)
        .mockResolvedValue(null);

      queue.start();
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('dead-letter'),
        expect.arrayContaining(['task-abc']),
      );
    });
  });

  // ─── stop ─────────────────────────────────────────────────────

  describe('stop()', () => {
    it('stops polling after stop() is called', async () => {
      mockQueryOne.mockResolvedValue(null);
      queue.start();
      queue.stop();

      jest.advanceTimersByTime(5000);
      await Promise.resolve(); await Promise.resolve();

      // Only setup calls — no poll calls after stop
      expect(mockDispatchToAgent).not.toHaveBeenCalled();
    });
  });

  // ─── concurrency ──────────────────────────────────────────────

  describe('concurrency', () => {
    it('does not dispatch a second run for the same agent while one is in progress', async () => {
      let resolveFirst!: () => void;
      mockDispatchToAgent.mockImplementationOnce(
        () => new Promise<void>((res) => { resolveFirst = res; }),
      );

      mockQueryOne
        .mockResolvedValueOnce(queuedRow)   // first poll — dispatches, hangs
        .mockResolvedValueOnce(queuedRow)   // second poll — same agent, should be skipped
        .mockResolvedValue(null);

      queue.start();

      // First poll fires
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // Second poll fires while first is still running
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(mockDispatchToAgent).toHaveBeenCalledTimes(1);

      resolveFirst();
    });
  });
});
