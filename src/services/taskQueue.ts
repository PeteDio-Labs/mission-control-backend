/**
 * TaskQueue
 *
 * Postgres-backed durable task queue for agent dispatch.
 * Replaces fire-and-forget dispatch with retryable, prioritised delivery.
 *
 * Design:
 *   - enqueue()  : inserts a row with status='queued' into agent_runs
 *   - poll loop  : SELECT FOR UPDATE SKIP LOCKED → lock → dispatch
 *   - on failure : exponential backoff retry (30s → 60s → 300s)
 *   - dead-letter: after max_retries, status='dead-letter'
 *   - concurrency: per-agent limit (default 1) + global Ollama gate
 */

import { randomUUID } from 'crypto';
import db from '../db/client.js';
import { logger } from '../utils/logger.js';
import { dispatchToAgent as defaultDispatch } from './agentDispatcher.js';
import type { TaskPayload } from '@petedio/shared/agents';

// ─── Config ────────────────────────────────────────────────────────

export interface TaskQueueOptions {
  pollIntervalMs?: number;
  /** Max simultaneous dispatches per agent name (default 1) */
  maxConcurrencyPerAgent?: number;
  /** Max simultaneous Ollama tool-loop agents (default 2) */
  maxOllamaConcurrency?: number;
}

// Retry backoff steps in ms: 30s, 60s, 5m
const RETRY_DELAYS_MS = [30_000, 60_000, 5 * 60_000];

// ─── Service ────────────────────────────────────────────────────────

export class TaskQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrencyPerAgent: number;
  private readonly maxOllamaConcurrency: number;

  /** agent_name → count of in-flight dispatches */
  private inFlight: Map<string, number> = new Map();
  /** total in-flight tool-loop agents (Ollama gate) */
  private ollamaGate = 0;
  private readonly dispatch: (payload: TaskPayload) => Promise<void>;

  constructor(
    opts: TaskQueueOptions = {},
    dispatch: (payload: TaskPayload) => Promise<void> = defaultDispatch,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.maxConcurrencyPerAgent = opts.maxConcurrencyPerAgent ?? 1;
    this.maxOllamaConcurrency = opts.maxOllamaConcurrency ?? 2;
    this.dispatch = dispatch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        logger.error('TaskQueue: tick error', { error: (err as Error).message }),
      );
    }, this.pollIntervalMs);
    logger.info('TaskQueue started', {
      pollIntervalMs: this.pollIntervalMs,
      maxConcurrencyPerAgent: this.maxConcurrencyPerAgent,
      maxOllamaConcurrency: this.maxOllamaConcurrency,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('TaskQueue stopped');
  }

  // ─── enqueue ────────────────────────────────────────────────────

  async enqueue(
    payload: TaskPayload,
    opts: { priority?: number; maxRetries?: number; timeoutMinutes?: number } = {},
  ): Promise<void> {
    const priority = opts.priority ?? 5;
    const maxRetries = opts.maxRetries ?? 3;
    const timeoutAt = opts.timeoutMinutes
      ? new Date(Date.now() + opts.timeoutMinutes * 60_000).toISOString()
      : null;

    await db.queryOne(
      `INSERT INTO agent_runs
         (task_id, agent_name, trigger, input, issued_at, status, priority, max_retries, timeout_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8)
       ON CONFLICT (task_id) DO NOTHING`,
      [
        payload.taskId,
        payload.agentName,
        payload.trigger,
        JSON.stringify(payload.input),
        payload.issuedAt,
        priority,
        maxRetries,
        timeoutAt,
      ],
    );

    logger.info('TaskQueue: task enqueued', {
      taskId: payload.taskId,
      agentName: payload.agentName,
      priority,
    });
  }

  // ─── poll tick ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.ollamaGate >= this.maxOllamaConcurrency) {
      logger.debug('TaskQueue: Ollama gate full, skipping poll');
      return;
    }

    // Pick the highest-priority queued row that isn't blocked by concurrency limits
    // FOR UPDATE SKIP LOCKED prevents two MC Backend instances from double-picking
    const row = await db.queryOne<{
      task_id: string;
      agent_name: string;
      trigger: string;
      input: Record<string, unknown>;
      issued_at: string;
      retry_count: number;
      max_retries: number;
    }>(
      `SELECT task_id, agent_name, trigger, input, issued_at, retry_count, max_retries
       FROM agent_runs
       WHERE status = 'queued'
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [],
    );

    if (!row) return;

    const agentFlying = this.inFlight.get(row.agent_name) ?? 0;
    if (agentFlying >= this.maxConcurrencyPerAgent) {
      logger.debug('TaskQueue: agent concurrency limit reached, skipping', {
        agentName: row.agent_name,
        inFlight: agentFlying,
      });
      return;
    }

    // Lock the row
    const instanceId = randomUUID();
    await db.queryOne(
      `UPDATE agent_runs
       SET status = 'running', locked_by = $1, locked_at = NOW()
       WHERE task_id = $2`,
      [instanceId, row.task_id],
    );

    const payload: TaskPayload = {
      taskId: row.task_id,
      agentName: row.agent_name,
      trigger: row.trigger as TaskPayload['trigger'],
      input: row.input,
      issuedAt: row.issued_at,
    };

    this.inFlight.set(row.agent_name, agentFlying + 1);
    this.ollamaGate++;

    this.runDispatch(payload, row.retry_count, row.max_retries, instanceId).finally(() => {
      this.inFlight.set(row.agent_name, (this.inFlight.get(row.agent_name) ?? 1) - 1);
      this.ollamaGate = Math.max(0, this.ollamaGate - 1);
    });
  }

  private async runDispatch(
    payload: TaskPayload,
    retryCount: number,
    maxRetries: number,
    _lockedBy: string,
  ): Promise<void> {
    try {
      await this.dispatch(payload);
      // Dispatcher updates status to 'running' or 'failed' internally — nothing to do here
      logger.info('TaskQueue: dispatch accepted', {
        taskId: payload.taskId,
        agentName: payload.agentName,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('TaskQueue: dispatch error', {
        taskId: payload.taskId,
        agentName: payload.agentName,
        retryCount,
        maxRetries,
        error: message,
      });

      if (retryCount >= maxRetries) {
        // Dead-letter
        await db.queryOne(
          `UPDATE agent_runs
           SET status = 'dead-letter', locked_by = NULL, locked_at = NULL
           WHERE task_id = $1`,
          [payload.taskId],
        );
        logger.warn('TaskQueue: task dead-lettered', {
          taskId: payload.taskId,
          agentName: payload.agentName,
          retryCount,
        });
      } else {
        // Exponential backoff
        const delayMs = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        await db.queryOne(
          `UPDATE agent_runs
           SET status = 'queued',
               retry_count = retry_count + 1,
               next_retry_at = $1,
               locked_by = NULL,
               locked_at = NULL
           WHERE task_id = $2`,
          [nextRetryAt, payload.taskId],
        );
        logger.info('TaskQueue: task re-queued for retry', {
          taskId: payload.taskId,
          retryCount: retryCount + 1,
          nextRetryAt,
        });
      }
    }
  }
}
