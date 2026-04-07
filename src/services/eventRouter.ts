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
import { insertRun } from './agentStore.js';
import { dispatchToAgent } from './agentDispatcher.js';
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
  /** Build the agent input from the event */
  buildInput: (event: InfraEvent) => Record<string, unknown>;
}

// ─── Routing rules ───────────────────────────────────────────────

const RULES: RoutingRule[] = [
  {
    name: 'deploy → blog-agent',
    agentName: 'blog-agent',
    trigger: 'infra-event',
    cooldownMs: 10 * 60 * 1000, // 10 min — don't spam on rapid redeploys
    match: {
      source: 'kubernetes',
      type: 'deployment',
      severity: 'info',
    },
    buildInput: (event) => ({
      contentType: 'deploy-changelog',
      topic: event.affected_service
        ? `${event.affected_service} deployment update`
        : 'service deployment update',
      context: {
        service: event.affected_service,
        namespace: event.namespace,
        image: (event.metadata as Record<string, unknown> | undefined)?.image,
        previousImage: (event.metadata as Record<string, unknown> | undefined)?.previousImage,
        eventMessage: event.message,
      },
    }),
  },
  {
    name: 'critical alert → ops-investigator',
    agentName: 'ops-investigator',
    trigger: 'infra-event',
    cooldownMs: 15 * 60 * 1000, // 15 min
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

const lastFiredAt: Map<string, number> = new Map();

function isOnCooldown(ruleName: string, cooldownMs: number): boolean {
  const last = lastFiredAt.get(ruleName);
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

function markFired(ruleName: string): void {
  lastFiredAt.set(ruleName, Date.now());
}

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

  start(): void {
    if (this.started) return;
    this.started = true;

    eventBus.on('event', (rawEvent: unknown) => {
      const event = rawEvent as InfraEvent;
      this.route(event).catch((err) =>
        logger.error('EventRouter: unhandled error', { error: (err as Error).message }),
      );
    });

    logger.info(`EventRouter started — ${RULES.length} rules loaded`);
  }

  private async route(event: InfraEvent): Promise<void> {
    for (const rule of RULES) {
      if (!matchesRule(event, rule)) continue;

      const cooldown = rule.cooldownMs ?? 5 * 60 * 1000;
      if (isOnCooldown(rule.name, cooldown)) {
        logger.debug('EventRouter: rule on cooldown, skipping', { rule: rule.name });
        continue;
      }

      markFired(rule.name);
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
        await insertRun(payload);
        setImmediate(() => dispatchToAgent(payload));
      } catch (err) {
        logger.error('EventRouter: failed to insert/dispatch run', {
          rule: rule.name,
          error: (err as Error).message,
        });
      }
    }
  }
}
