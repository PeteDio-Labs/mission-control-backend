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
  'http://192.168.50.113:3005';

const PM_AGENT_URL =
  process.env.PM_AGENT_URL ||
  'http://192.168.50.113:3006';

const KNOWLEDGE_JANITOR_URL =
  process.env.KNOWLEDGE_JANITOR_URL ||
  'http://192.168.50.113:3007';

const WORKSTATION_AGENT_URL =
  process.env.WORKSTATION_AGENT_URL ||
  'http://192.168.50.113:3008';

const INFRA_AGENT_URL =
  process.env.INFRA_AGENT_URL ||
  'http://192.168.50.113:3009';

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
  'knowledge-janitor': {
    name: 'knowledge-janitor',
    url: KNOWLEDGE_JANITOR_URL,
    description: 'Audits knowledge/ for stale docs, proposes cleanup, ingests to RAG',
  },
  'workstation-agent': {
    name: 'workstation-agent',
    url: WORKSTATION_AGENT_URL,
    description: 'Executes shell commands, manages files, runs git/bun/kubectl ops on LXC 113',
  },
  'infra-agent': {
    name: 'infra-agent',
    url: INFRA_AGENT_URL,
    description: 'Runs Ansible playbooks and checks Proxmox capacity',
  },
};

export function getAgent(name: string): AgentDefinition | undefined {
  return AGENT_REGISTRY[name];
}
