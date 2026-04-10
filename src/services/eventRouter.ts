/**
 * Event Router
 *
 * Subscribes to the internal eventBus and maps InfraEvents → agent dispatch.
 * Each rule defines which events to match and what input to pass to the agent.
 *
 * Matching: ALL defined fields must match (source, type, severity, namespace).
 * Omitting a field means "match any value for that field".
 *
 * Cooldown: prevents the same rule from firing more than once per window,
 * so a flapping pod doesn't spawn 50 ops-investigator runs.
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { eventBus } from '../api/routes/events.js';
import type { TaskQueue } from './taskQueue.js';
import type { InfraEvent } from '@petedio/shared';
import type { TaskPayload } from '@petedio/shared/agents';

// ─── Rule definition ─────────────────────────────────────────────

interface RoutingRule {
  /** Human-readable name for logging */
  name: string;
  /** Which agent to dispatch */
  agentName: string;
  /** Trigger type recorded on the run */
  trigger: TaskPayload['trigger'];
  /** Event matchers — omit a field to match any value */
  match: {
    source?: InfraEvent['source'];
    type?: InfraEvent['type'];
    severity?: InfraEvent['severity'];
    /** Substring match on affected_service */
    serviceContains?: string;
    /** Substring match on namespace */
    namespaceContains?: string;
  };
  /** Cooldown in ms — rule won't fire again within this window (default: 5 min) */
  cooldownMs?: number;
  /** Queue priority — 1=critical, 5=normal (default: 5) */
  priority?: number;
  /** Build the agent input from the event */
  buildInput: (event: InfraEvent) => Record<string, unknown>;
}

// ─── Routing rules ───────────────────────────────────────────────

const RULES: RoutingRule[] = [
  // deploy → blog-agent rule removed: caused feedback loop (blog-agent deploy → K8s event → blog-agent → repeat)
  // Blog posts are scheduled (cron Mon/Wed/Sat) or manually triggered only.
  {
    name: 'critical alert → ops-investigator',
    agentName: 'ops-investigator',
    trigger: 'infra-event',
    cooldownMs: 15 * 60 * 1000, // 15 min
    priority: 1, // critical — jump the queue
    match: {
      severity: 'critical',
    },
    buildInput: (event) => ({
      focus: 'incident',
      summary: event.message,
      source: event.source,
      eventType: event.type,
      service: event.affected_service,
      namespace: event.namespace,
      metadata: event.metadata,
    }),
  },
  {
    name: 'pod-failure → ops-investigator',
    agentName: 'ops-investigator',
    trigger: 'infra-event',
    cooldownMs: 10 * 60 * 1000,
    match: {
      source: 'kubernetes',
      type: 'pod-failure',
    },
    buildInput: (event) => ({
      focus: 'pod-failure',
      summary: event.message,
      service: event.affected_service,
      namespace: event.namespace,
      metadata: event.metadata,
    }),
  },
  {
    name: 'argocd sync-drift → ops-investigator',
    agentName: 'ops-investigator',
    trigger: 'infra-event',
    cooldownMs: 20 * 60 * 1000,
    match: {
      source: 'argocd',
      type: 'sync-drift',
    },
    buildInput: (event) => ({
      focus: 'sync-drift',
      summary: event.message,
      service: event.affected_service,
      namespace: event.namespace,
    }),
  },
];

// ─── Cooldown tracker ─────────────────────────────────────────────
// Kept as instance state on EventRouter so tests can create isolated instances.

// ─── Matcher ─────────────────────────────────────────────────────

function matchesRule(event: InfraEvent, rule: RoutingRule): boolean {
  const { match } = rule;
  if (match.source && event.source !== match.source) return false;
  if (match.type && event.type !== match.type) return false;
  if (match.severity && event.severity !== match.severity) return false;
  if (match.serviceContains && !event.affected_service?.includes(match.serviceContains)) return false;
  if (match.namespaceContains && !event.namespace?.includes(match.namespaceContains)) return false;
  return true;
}

// ─── Router ──────────────────────────────────────────────────────

export class EventRouter {
  private started = false;
  private listener: ((rawEvent: unknown) => void) | null = null;
  private lastFiredAt: Map<string, number> = new Map();

  constructor(private queue: TaskQueue) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.listener = (rawEvent: unknown) => {
      const event = rawEvent as InfraEvent;
      this.route(event).catch((err) =>
        logger.error('EventRouter: unhandled error', { error: (err as Error).message }),
      );
    };

    eventBus.on('event', this.listener);
    logger.info(`EventRouter started — ${RULES.length} rules loaded`);
  }

  stop(): void {
    if (this.listener) {
      eventBus.off('event', this.listener);
      this.listener = null;
    }
    this.started = false;
    logger.info('EventRouter stopped');
  }

  private async route(event: InfraEvent): Promise<void> {
    for (const rule of RULES) {
      if (!matchesRule(event, rule)) continue;

      const cooldown = rule.cooldownMs ?? 5 * 60 * 1000;
      const last = this.lastFiredAt.get(rule.name);
      if (last && Date.now() - last < cooldown) {
        logger.debug('EventRouter: rule on cooldown, skipping', { rule: rule.name });
        continue;
      }

      this.lastFiredAt.set(rule.name, Date.now());
      logger.info('EventRouter: rule matched — dispatching agent', {
        rule: rule.name,
        agentName: rule.agentName,
        eventType: event.type,
        eventSource: event.source,
      });

      const payload: TaskPayload = {
        taskId: randomUUID(),
        agentName: rule.agentName,
        trigger: rule.trigger,
        input: rule.buildInput(event),
        issuedAt: new Date().toISOString(),
      };

      try {
        await this.queue.enqueue(payload, { priority: rule.priority ?? 5 });
      } catch (err) {
        logger.error('EventRouter: failed to enqueue run', {
          rule: rule.name,
          error: (err as Error).message,
        });
      }
    }
  }
}
