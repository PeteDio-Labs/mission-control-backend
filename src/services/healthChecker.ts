/**
 * HealthChecker
 *
 * Polls each registered agent's GET /health endpoint on a configurable interval.
 * Tracks liveness state in memory and fires a notify callback on status transitions
 * (ok → unreachable and unreachable → ok).
 *
 * The `check()` method is public so callers can trigger an immediate sweep
 * (e.g. right after start() on boot).
 */

import { logger } from '../utils/logger.js';
import type { AgentDefinition } from '../config/agents.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentHealthStatus {
  status: 'ok' | 'unreachable';
  checkedAt: string;
}

export interface HealthCheckerOptions {
  intervalMs?: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type NotifyFn = (agentName: string, status: 'ok' | 'unreachable') => Promise<void>;

// ─── Service ────────────────────────────────────────────────────────

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly health: Map<string, AgentHealthStatus> = new Map();
  private readonly intervalMs: number;

  constructor(
    private readonly agents: AgentDefinition[],
    opts: HealthCheckerOptions = {},
    private readonly fetcher: Fetcher = fetch,
    private readonly notify?: NotifyFn,
  ) {
    this.intervalMs = opts.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.check().catch(err =>
        logger.error('HealthChecker: check error', { error: (err as Error).message }),
      );
    }, this.intervalMs);
    logger.info('HealthChecker started', {
      agentCount: this.agents.length,
      intervalMs: this.intervalMs,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('HealthChecker stopped');
  }

  getHealth(name: string): AgentHealthStatus | undefined {
    return this.health.get(name);
  }

  getAllHealth(): Record<string, AgentHealthStatus> {
    return Object.fromEntries(this.health.entries());
  }

  async check(): Promise<void> {
    await Promise.all(this.agents.map(agent => this.checkOne(agent)));
  }

  private async checkOne(agent: AgentDefinition): Promise<void> {
    const previous = this.health.get(agent.name);
    let status: 'ok' | 'unreachable';

    try {
      const res = await this.fetcher(`${agent.url}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      status = res.ok ? 'ok' : 'unreachable';
    } catch {
      status = 'unreachable';
    }

    const checkedAt = new Date().toISOString();
    this.health.set(agent.name, { status, checkedAt });

    if (previous !== undefined && previous.status !== status) {
      if (status === 'unreachable') {
        logger.warn('HealthChecker: agent went unreachable', { agentName: agent.name });
      } else {
        logger.info('HealthChecker: agent recovered', { agentName: agent.name });
      }
      await this.notify?.(agent.name, status);
    }
  }
}
