import { Registry, Counter, Gauge, Histogram } from 'prom-client';

// Create a new registry
export const register = new Registry();

// Mission Control Backend Metrics

// Application health
export const appUp = new Gauge({
  name: 'mission_control_backend_up',
  help: '1=backend running, 0=offline',
  registers: [register],
});

// Database connection
export const databaseConnections = new Gauge({
  name: 'mission_control_database_connections',
  help: 'Number of active database connections',
  registers: [register],
});

// Kubernetes connector metrics
export const kubernetesAvailable = new Gauge({
  name: 'mission_control_kubernetes_available',
  help: '1=Kubernetes API reachable, 0=unavailable',
  registers: [register],
});

export const kubernetesRequestDuration = new Histogram({
  name: 'mission_control_kubernetes_request_duration_seconds',
  help: 'Kubernetes API request duration in seconds',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Proxmox connector metrics
export const proxmoxAvailable = new Gauge({
  name: 'mission_control_proxmox_available',
  help: '1=Proxmox API reachable, 0=unavailable',
  registers: [register],
});

export const proxmoxRequestDuration = new Histogram({
  name: 'mission_control_proxmox_request_duration_seconds',
  help: 'Proxmox API request duration in seconds',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// ArgoCD connector metrics
export const argoCdAvailable = new Gauge({
  name: 'mission_control_argocd_available',
  help: '1=ArgoCD API reachable, 0=unavailable',
  registers: [register],
});

export const argoCdRequestDuration = new Histogram({
  name: 'mission_control_argocd_request_duration_seconds',
  help: 'ArgoCD API request duration in seconds',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Prometheus connector metrics
export const prometheusAvailable = new Gauge({
  name: 'mission_control_prometheus_available',
  help: '1=Prometheus reachable, 0=unavailable',
  registers: [register],
});

export const prometheusRequestDuration = new Histogram({
  name: 'mission_control_prometheus_request_duration_seconds',
  help: 'Prometheus query duration in seconds',
  buckets: [0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

// Task execution metrics
export const taskExecutionsTotal = new Counter({
  name: 'mission_control_task_executions_total',
  help: 'Total task executions',
  labelNames: ['status'],
  registers: [register],
});

export const taskExecutionDuration = new Histogram({
  name: 'mission_control_task_execution_duration_seconds',
  help: 'Task execution duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Notification service metrics
export const notificationPublishTotal = new Counter({
  name: 'mission_control_notification_publish_total',
  help: 'Total events published to notification service',
  labelNames: ['status'],
  registers: [register],
});

export const notificationPublishDuration = new Histogram({
  name: 'mission_control_notification_publish_duration_seconds',
  help: 'Notification service publish duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

// SSE event stream metrics
export const sseConnections = new Gauge({
  name: 'mission_control_sse_connections',
  help: 'Number of active SSE client connections',
  registers: [register],
});

export const sseEventsBroadcast = new Counter({
  name: 'mission_control_sse_events_broadcast_total',
  help: 'Total events broadcast to SSE clients',
  registers: [register],
});

// API endpoint metrics
export const apiRequestsTotal = new Counter({
  name: 'mission_control_api_requests_total',
  help: 'Total HTTP API requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

export const apiRequestDuration = new Histogram({
  name: 'mission_control_api_request_duration_seconds',
  help: 'HTTP API request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  register.resetMetrics();
}
