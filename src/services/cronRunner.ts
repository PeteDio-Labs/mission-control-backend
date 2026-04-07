/**
 * Cron Runner
 *
 * Schedules periodic agent triggers using setInterval (no external deps).
 * Each job fires on its interval, inserts a run record, and dispatches
 * to the agent. Jobs don't overlap — if a job is still running when the
 * next tick arrives, the tick is skipped.
 *
 * Schedule format: interval in ms (simple, reliable, no cron-string parsing).
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { insertRun } from './agentStore.js';
import { dispatchToAgent } from './agentDispatcher.js';
import type { TaskPayload } from '@petedio/shared/agents';

// ─── Job definition ──────────────────────────────────────────────

interface CronJob {
  name: string;
  agentName: string;
  intervalMs: number;
  /** Offset before first fire in ms (staggers jobs on startup) */
  initialDelayMs?: number;
  buildInput: () => Record<string, unknown>;
}

// ─── Schedule ────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const JOBS: CronJob[] = [
  {
    name: 'daily-ops-audit',
    agentName: 'ops-investigator',
    intervalMs: DAY,
    initialDelayMs: 2 * HOUR, // first run 2h after startup, then every 24h
    buildInput: () => ({
      focus: 'daily-audit',
      summary: 'Daily overnight health audit — check pods, nodes, ArgoCD sync status',
    }),
  },
  {
    name: 'weekly-blog-recap',
    agentName: 'blog-agent',
    intervalMs: 7 * DAY,
    initialDelayMs: 5 * HOUR, // first run 5h after startup
    buildInput: () => ({
      contentType: 'weekly-recap',
      topic: 'Weekly infrastructure and development recap',
    }),
  },
];

// ─── Runner ──────────────────────────────────────────────────────

export class CronRunner {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = new Set<string>();

  start(): void {
    for (const job of JOBS) {
      this.scheduleJob(job);
    }
    logger.info(`CronRunner started — ${JOBS.length} jobs scheduled`);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private scheduleJob(job: CronJob): void {
    const fire = async () => {
      if (this.running.has(job.name)) {
        logger.debug('CronRunner: job still running, skipping tick', { job: job.name });
        return;
      }

      this.running.add(job.name);
      logger.info('CronRunner: firing job', { job: job.name, agentName: job.agentName });

      const payload: TaskPayload = {
        taskId: randomUUID(),
        agentName: job.agentName,
        trigger: 'cron',
        input: job.buildInput(),
        issuedAt: new Date().toISOString(),
      };

      try {
        await insertRun(payload);
        await dispatchToAgent(payload);
      } catch (err) {
        logger.error('CronRunner: job dispatch failed', {
          job: job.name,
          error: (err as Error).message,
        });
      } finally {
        this.running.delete(job.name);
      }
    };

    // Initial delay before first fire, then repeat on interval
    const initialDelay = job.initialDelayMs ?? 0;
    const t = setTimeout(() => {
      fire();
      const interval = setInterval(fire, job.intervalMs);
      this.timers.push(interval as unknown as ReturnType<typeof setTimeout>);
    }, initialDelay);

    this.timers.push(t);
    logger.debug('CronRunner: job scheduled', {
      job: job.name,
      intervalHours: (job.intervalMs / HOUR).toFixed(1),
      initialDelayHours: ((initialDelay) / HOUR).toFixed(1),
    });
  }
}
