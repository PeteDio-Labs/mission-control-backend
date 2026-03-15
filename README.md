# Mission Control Backend

Bun/Express API server that aggregates homelab inventory and exposes it via REST. Connects to Kubernetes, Proxmox, ArgoCD, and Prometheus.

## Quick Start

```bash
bun install
cp .env.example .env   # fill in credentials
bun run db:migrate
bun dev                # http://localhost:3000
```

## Scripts

```bash
bun dev          # dev server with watch
bun build        # production build
bun test         # run tests (112 cases)
bun run lint
bun run db:migrate
bun run db:test  # verify DB connection
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Full health + DB status |
| `GET /health/live` | Liveness probe |
| `GET /health/ready` | Readiness probe |
| `GET /metrics` | Prometheus metrics |
| `GET /api/v1/inventory` | All hosts + workloads |
| `GET /api/v1/inventory/hosts` | K8s/Proxmox hosts |
| `GET /api/v1/inventory/workloads` | K8s workloads |
| `POST /api/v1/inventory/sync` | Trigger discovery |

## Stack

- **Runtime:** Bun, TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL 15 (15 tables)
- **Connectors:** `@kubernetes/client-node`, Proxmox REST, ArgoCD, Prometheus
- **Logging:** Pino
- **Validation:** Zod

## Connectors

| Connector | Status |
|-----------|--------|
| Kubernetes | ✅ Active |
| Proxmox | ✅ Active |
| ArgoCD | ✅ Implemented |
| Prometheus | ✅ Active |
