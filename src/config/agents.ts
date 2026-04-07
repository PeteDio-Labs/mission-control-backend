/**
 * Agent Registry
 *
 * Maps agent names to their runtime URLs and supported trigger types.
 * URL is read from env so it works in both local dev (port-forwards)
 * and in-cluster (K8s DNS).
 */

export interface AgentDefinition {
  name: string;
  url: string; // base URL — dispatcher POSTs to {url}/run
  description: string;
}

const BLOG_AGENT_URL =
  process.env.BLOG_AGENT_URL ||
  'http://blog-agent.blog-dev.svc.cluster.local:3004';

const OPS_INVESTIGATOR_URL =
  process.env.OPS_INVESTIGATOR_URL ||
  'http://ops-investigator.blog-dev.svc.cluster.local:3005';

const PM_AGENT_URL =
  process.env.PM_AGENT_URL ||
  'http://pm-agent.blog-dev.svc.cluster.local:3006';

export const AGENT_REGISTRY: Record<string, AgentDefinition> = {
  'blog-agent': {
    name: 'blog-agent',
    url: BLOG_AGENT_URL,
    description: 'Generates blog content from infra events and schedules',
  },
  'ops-investigator': {
    name: 'ops-investigator',
    url: OPS_INVESTIGATOR_URL,
    description: 'Investigates infra alerts and pod failures',
  },
  'pm-agent': {
    name: 'pm-agent',
    url: PM_AGENT_URL,
    description: 'Manages project tasks and planning documents',
  },
};

export function getAgent(name: string): AgentDefinition | undefined {
  return AGENT_REGISTRY[name];
}
