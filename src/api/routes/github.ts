/**
 * GitHub Webhook Handler — POST /api/v1/github/webhook
 *
 * Receives GitHub webhook events, validates the HMAC-SHA256 signature,
 * maps event + action → agent dispatch.
 *
 * Supported events:
 *   issues.opened (label: agent:blog)    → blog-agent
 *   issues.opened (label: agent:ops)     → ops-investigator
 *   push (to main/develop)               → blog-agent (deploy-changelog)
 *
 * Requires `X-Hub-Signature-256` HMAC-SHA256 signature over the raw body
 * using `GITHUB_WEBHOOK_SECRET`. Presence of the env var is guaranteed by
 * the boot validator in `src/config/requiredSecrets.ts` (SEC.1 / C2) — a
 * missing value crashes the pod at startup rather than accepting unauthed
 * webhooks.
 */

import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { insertRun } from '../../services/agentStore.js';
import { dispatchToAgent } from '../../services/agentDispatcher.js';
import type { TaskPayload } from '@petedio/shared/agents';

const router = Router();

// ─── Signature validation ─────────────────────────────────────────

export function verifySignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Event → agent mapping ────────────────────────────────────────

type GitHubIssue = {
  number: number;
  title: string;
  html_url: string;
  labels: Array<{ name: string }>;
  body?: string;
};

type GitHubPush = {
  ref: string;
  repository: { full_name: string };
  head_commit?: { message: string; id: string };
  pusher: { name: string };
};

async function handleIssuesOpened(issue: GitHubIssue, repo: string): Promise<string | null> {
  const labelNames = issue.labels.map((l) => l.name);

  let agentName: string | null = null;
  let input: Record<string, unknown> = {};

  if (labelNames.includes('agent:blog')) {
    agentName = 'blog-agent';
    input = {
      contentType: 'how-to',
      topic: issue.title,
      context: {
        issueUrl: issue.html_url,
        issueBody: issue.body ?? '',
        repo,
      },
    };
  } else if (labelNames.includes('agent:ops')) {
    agentName = 'ops-investigator';
    input = {
      focus: 'issue-triage',
      summary: issue.title,
      context: {
        issueUrl: issue.html_url,
        issueBody: issue.body ?? '',
        repo,
      },
    };
  }

  if (!agentName) return null;

  const payload: TaskPayload = {
    taskId: randomUUID(),
    agentName,
    trigger: 'github',
    input,
    issuedAt: new Date().toISOString(),
  };

  await insertRun(payload);
  setImmediate(() => dispatchToAgent(payload));
  return payload.taskId;
}

async function handlePush(push: GitHubPush): Promise<string | null> {
  // Only fire on pushes to main or develop
  const branch = push.ref.replace('refs/heads/', '');
  if (branch !== 'main' && branch !== 'develop') return null;

  const payload: TaskPayload = {
    taskId: randomUUID(),
    agentName: 'blog-agent',
    trigger: 'github',
    input: {
      contentType: 'deploy-changelog',
      topic: `${push.repository.full_name} — ${branch} push`,
      context: {
        repo: push.repository.full_name,
        branch,
        commit: push.head_commit?.id,
        commitMessage: push.head_commit?.message,
        pusher: push.pusher.name,
      },
    },
    issuedAt: new Date().toISOString(),
  };

  await insertRun(payload);
  setImmediate(() => dispatchToAgent(payload));
  return payload.taskId;
}

// ─── Route ────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  // Boot validator (src/config/requiredSecrets.ts) guarantees this is set.
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = req.headers['x-github-event'] as string | undefined;
  // RETRO.13: use rawBody captured by express.json({verify}) — JSON.stringify
  // is NOT byte-equivalent to what GitHub signed, so signature verify was
  // unreliable. Missing rawBody = server misconfigured (verify cb never fired).
  const rawBody = (req as Request & { rawBody?: string }).rawBody;

  if (rawBody === undefined) {
    logger.error('GitHub webhook: rawBody missing — express.json verify middleware not wired');
    res.status(500).json({ error: 'Server misconfigured (rawBody)' });
    return;
  }
  if (!verifySignature(rawBody, signature, secret)) {
    logger.warn('GitHub webhook: invalid or missing signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  if (!event) {
    res.status(400).json({ error: 'Missing X-GitHub-Event header' });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const action = body.action as string | undefined;

  logger.info('GitHub webhook received', { event, action });

  try {
    let taskId: string | null = null;

    if (event === 'issues' && action === 'opened') {
      const repo = (body.repository as Record<string, unknown>)?.full_name as string ?? 'unknown';
      taskId = await handleIssuesOpened(body.issue as GitHubIssue, repo);
    } else if (event === 'push') {
      taskId = await handlePush(body as unknown as GitHubPush);
    }

    if (taskId) {
      logger.info('GitHub webhook dispatched agent', { event, action, taskId });
      res.json({ dispatched: true, taskId });
    } else {
      res.json({ dispatched: false, reason: 'No matching rule for this event' });
    }
  } catch (err) {
    logger.error('GitHub webhook handler error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal error processing webhook' });
  }
});

export default router;
