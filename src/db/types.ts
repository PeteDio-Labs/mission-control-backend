/**
 * Database Model Type Definitions
 * These types match the database schema
 */

// =============================================================================
// INVENTORY TYPES
// =============================================================================

export type HostType =
  | 'proxmox-node'
  | 'vm'
  | 'k8s-node'
  | 'docker-host'
  | 'lxc-container';

export type HostStatus = 'online' | 'offline' | 'degraded' | 'unknown';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export interface Host {
  id: string;
  name: string;
  type: HostType;
  cluster: string | null;
  addresses: {
    lan?: string;
    tailscale?: string;
    public?: string;
  };
  status: HostStatus;
  last_seen_at: Date | null;
  tags: string[];
  metadata: JsonObject;
  created_at: Date;
  updated_at: Date;
}

export type WorkloadType =
  | 'k8s-deployment'
  | 'k8s-statefulset'
  | 'k8s-pod'
  | 'k8s-daemonset'
  | 'proxmox-vm'
  | 'proxmox-lxc'
  | 'docker-container'
  | 'compose-stack';

export type WorkloadStatus =
  | 'running'
  | 'stopped'
  | 'pending'
  | 'failed'
  | 'unknown';

export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface Workload {
  id: string;
  name: string;
  type: WorkloadType;
  host_id: string | null;
  status: WorkloadStatus;
  namespace: string | null;
  spec: JsonObject;
  health_status: HealthStatus;
  last_updated_at: Date | null;
  metadata: JsonObject;
  created_at: Date;
  updated_at: Date;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  workload_ids: string[];
  urls: string[];
  slo_targets: JsonObject;
  runbook_url: string | null;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

// =============================================================================
// TASK & RUN TYPES
// =============================================================================

export interface Task {
  id: string;
  title: string;
  description: string | null;
  created_by: string;
  is_template: boolean;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

export type TaskRunStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface TaskRun {
  id: string;
  task_id: string | null;
  user_prompt: string;
  status: TaskRunStatus;
  result: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  metadata: JsonObject;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

export type TaskEventType =
  | 'log'
  | 'tool_call'
  | 'tool_result'
  | 'llm_request'
  | 'llm_response'
  | 'approval_required'
  | 'status_change'
  | 'artifact'
  | 'error';

export interface TaskEvent {
  id: string;
  run_id: string;
  timestamp: Date;
  type: TaskEventType;
  data: JsonObject;
  metadata: JsonObject;
}

export type ArtifactType =
  | 'text'
  | 'json'
  | 'markdown'
  | 'file'
  | 'link'
  | 'image';

export interface Artifact {
  id: string;
  run_id: string;
  type: ArtifactType;
  uri: string;
  label: string | null;
  metadata: JsonObject;
  created_at: Date;
}

// =============================================================================
// TOOLS & POLICIES TYPES
// =============================================================================

export type RiskLevel = 'READ_ONLY' | 'SAFE_MUTATE' | 'DESTRUCTIVE';

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  risk_level: RiskLevel;
  requires_approval: boolean;
  json_schema: JsonObject;
  tags: string[];
  connector_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ToolCallRecord {
  id: string;
  run_id: string;
  tool_id: string | null;
  tool_name: string;
  args: JsonObject;
  started_at: Date;
  ended_at: Date | null;
  success: boolean | null;
  result_size: number;
  error_message: string | null;
  metadata: JsonObject;
}

export interface PolicyRule {
  effect: 'allow' | 'deny';
  toolId?: string;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  timeWindow?: {
    daysOfWeek?: number[];
    hoursUtc?: number[];
  };
}

export interface Policy {
  id: string;
  name: string;
  description: string | null;
  rules: PolicyRule[];
  active_from: Date;
  active_to: Date | null;
  created_at: Date;
  updated_at: Date;
}

// =============================================================================
// AUDIT LOG TYPES
// =============================================================================

export type AuditOutcome = 'success' | 'failure';

export interface AuditEntry {
  id: string;
  timestamp: Date;
  actor: {
    clientId: string;
    userId?: string;
  };
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: {
    before?: JsonObject;
    after?: JsonObject;
  } | null;
  outcome: AuditOutcome;
  reason: string | null;
  metadata: JsonObject;
}

// =============================================================================
// VIEW TYPES
// =============================================================================

export interface ToolCallSuccessRate {
  tool_name: string;
  total_calls: number;
  successful_calls: number;
  success_rate_pct: number;
  avg_duration_ms: number;
}

// =============================================================================
// INPUT TYPES (for creating records)
// =============================================================================

export type CreateHost = Omit<Host, 'id' | 'created_at' | 'updated_at'>;
export type CreateWorkload = Omit<Workload, 'id' | 'created_at' | 'updated_at'>;
export type CreateService = Omit<Service, 'id' | 'created_at' | 'updated_at'>;
export type CreateTask = Omit<Task, 'id' | 'created_at' | 'updated_at'>;
export type CreateTaskRun = Omit<TaskRun, 'id' | 'created_at' | 'started_at' | 'ended_at'>;
export type CreateTaskEvent = Omit<TaskEvent, 'id' | 'timestamp'>;
export type CreateArtifact = Omit<Artifact, 'id' | 'created_at'>;
export type CreateToolDefinition = Omit<ToolDefinition, 'id' | 'created_at' | 'updated_at'>;
export type CreateToolCallRecord = Omit<ToolCallRecord, 'id' | 'started_at'>;
export type CreatePolicy = Omit<Policy, 'id' | 'created_at' | 'updated_at'>;
export type CreateAuditEntry = Omit<AuditEntry, 'id' | 'timestamp'>;
