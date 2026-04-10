/**
 * TaskReaper
 *
 * Detects and reaps zombie tasks:
 *   - `running` rows where locked_at exceeds the stale TTL (default 30 min)
 *     or where timeout_at has passed
 *   - `waiting_approval` rows that have exceeded the approval TTL (default 15 min)
 *
 * Marks reaped rows as `failed` with a timeout summary.
 * Runs on a configurable interval (default 60s).
 */

import db from '../db/client.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface TaskReaperOptions {
  intervalMs?: number;
  /** Minutes before a running task is considered a zombie (default 30) */
  staleTtlMinutes?: number;
  /** Minutes before a waiting_approval task times out (default 15) */
  approvalTtlMinutes?: number;
}

type DbClient = { queryMany: typeof db.queryMany };

// ─── Service ────────────────────────────────────────────────────────

export class TaskReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly staleTtlMinutes: number;
  private readonly approvalTtlMinutes: number;

  constructor(
    opts: TaskReaperOptions = {},
    private readonly dbClient: DbClient = db,
  ) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.staleTtlMinutes = opts.staleTtlMinutes ?? 30;
    this.approvalTtlMinutes = opts.approvalTtlMinutes ?? 15;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reap().catch(err =>
        logger.error('TaskReaper: reap error', { error: (err as Error).message }),
      );
    }, this.intervalMs);
    logger.info('TaskReaper started', {
      intervalMs: this.intervalMs,
      staleTtlMinutes: this.staleTtlMinutes,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('TaskReaper stopped');
  }

  async reap(): Promise<{ reaped: number; expired: number }> {
    const staleCutoff = new Date(Date.now() - this.staleTtlMinutes * 60_000).toISOString();
    const approvalCutoff = new Date(Date.now() - this.approvalTtlMinutes * 60_000).toISOString();

    const stale = await this.dbClient.queryMany<{ task_id: string; agent_name: string }>(
      `UPDATE agent_runs
       SET status       = 'dead-letter',
           locked_by    = NULL,
           locked_at    = NULL,
           completed_at = NOW(),
           summary      = 'Task reaped: no heartbeat within stale TTL'
       WHERE status = 'running'
         AND (
           (timeout_at IS NOT NULL AND timeout_at < NOW())
           OR locked_at < $1
         )
       RETURNING task_id, agent_name`,
      [staleCutoff],
    );

    const expired = await this.dbClient.queryMany<{ task_id: string; agent_name: string }>(
      `UPDATE agent_runs
       SET status       = 'failed',
           completed_at = NOW(),
           summary      = 'Approval timed out'
       WHERE status = 'waiting_approval'
         AND locked_at < $1
       RETURNING task_id, agent_name`,
      [approvalCutoff],
    );

    for (const row of stale) {
      logger.warn('TaskReaper: reaped timed-out task', {
        taskId: row.task_id,
        agentName: row.agent_name,
      });
    }
    for (const row of expired) {
      logger.warn('TaskReaper: reaped expired approval', {
        taskId: row.task_id,
        agentName: row.agent_name,
      });
    }

    return { reaped: stale.length, expired: expired.length };
  }
}
