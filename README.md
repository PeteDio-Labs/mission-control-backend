# Mission Control Backend

REST API for PeteDio homelab infrastructure management. Aggregates inventory from Kubernetes, Proxmox, ArgoCD, and Prometheus. Serves as the data layer for Pete Bot and Mission Control Web UI.

## Quick Start

```bash
bun install
cp .env.example .env  # configure DB, K8s, Proxmox, Prometheus, Ollama
bun dev               # http://localhost:3000
```

## Scripts

```bash
bun dev          # dev server (port 3000, hot reload)
bun build        # production build
bun start        # run production build
bun test         # run tests
bun run typecheck
```

## Stack

- **Runtime:** Bun
- **Framework:** Express 5, TypeScript
- **Validation:** Zod v4
- **Database:** PostgreSQL
- **Logging:** Pino
- **Metrics:** prom-client (Prometheus)

## Architecture

```
Pete Bot / Mission Control Web
    │
    └──→ mission-control-backend (port 3000)
              │
              ├──→ Kubernetes (MicroK8s API)
              ├──→ Proxmox (REST API)
              ├──→ ArgoCD (REST API)
              ├──→ Prometheus (query API)
              └──→ Ollama (model/status queries)
```

## API

### Inventory
- `GET /api/v1/inventory` — Aggregated K8s + Proxmox inventory
- `GET /api/v1/inventory/hosts` — Hosts (K8s nodes, Proxmox VMs/LXCs)
- `GET /api/v1/inventory/workloads` — K8s workloads

### ArgoCD
- `GET /api/v1/argocd/apps` — ArgoCD application status

### Proxmox
- `GET /api/v1/proxmox/nodes` — Proxmox node list
- `GET /api/v1/proxmox/vms` — VM and LXC list

### Health & Metrics
- `GET /health` — Health check with connector status
- `GET /health/live` — Liveness probe
- `GET /health/ready` — Readiness probe
- `GET /metrics` — Prometheus metrics

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `DATABASE_URL` | PostgreSQL connection string |
| `K8S_CLUSTER_URL` | Kubernetes API server URL |
| `K8S_TOKEN` | Kubernetes service account token |
| `PROXMOX_HOST` | Proxmox API host (https://host:8006) |
| `PROXMOX_API_TOKEN` | Proxmox API token |
| `PROMETHEUS_URL` | Prometheus endpoint |
| `ARGOCD_URL` | ArgoCD server URL |
| `ARGOCD_TOKEN` | ArgoCD API token |
| `OLLAMA_HOST` | Ollama endpoint (default: http://localhost:11434) |

## Deployment

Pushed to `docker.toastedbytes.com/mission-control-backend` via GitHub Actions on push to `main`. ArgoCD Image Updater handles digest pinning. K8s manifests live in `infrastructure/kubernetes/mission-control`. Deployed in `mission-control` (dev) and `mission-control-prod` (prod) namespaces.
