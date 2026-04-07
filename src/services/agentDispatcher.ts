/**
 * Agent Dispatcher
 *
 * Given a TaskPayload already recorded in the DB, POSTs it to the
 * agent's /run endpoint. Fire-and-forget — the agent responds 202
 * immediately and reports back via the /status and /result routes.
 *
 * Fails gracefully: if the agent is unreachable, the run stays in
 * the DB as 'running' and will time out naturally. MC Web shows it.
 */

import { logger } from '../utils/logger.js';
import { getAgent } from '../config/agents.js';
import { updateStatus } from './agentStore.js';
import type { TaskPayload } from '@petedio/shared/agents';

const DISPATCH_TIMEOUT_MS = 10_000;

export async function dispatchToAgent(payload: TaskPayload): Promise<void> {
  const agent = getAgent(payload.agentName);

  if (!agent) {
    logger.warn('dispatchToAgent: no agent registered', { agentName: payload.agentName });
    await updateStatus({
      taskId: payload.taskId,
      agentName: payload.agentName,
      status: 'failed',
      message: `No agent registered with name "${payload.agentName}"`,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  const runUrl = `${agent.url}/run`;
  logger.info('Dispatching to agent', { agentName: payload.agentName, url: runUrl, taskId: payload.taskId });

  try {
    const res = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Agent /run returned ${res.status}: ${text}`);
    }

    logger.info('Agent accepted task', { agentName: payload.agentName, taskId: payload.taskId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to dispatch to agent', { agentName: payload.agentName, taskId: payload.taskId, error: message });

    await updateStatus({
      taskId: payload.taskId,
      agentName: payload.agentName,
      status: 'failed',
      message: `Dispatch failed: ${message}`,
      updatedAt: new Date().toISOString(),
    });
  }
}
