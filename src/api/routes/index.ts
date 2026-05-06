/**
 * Route index
 * Mounts all API routers in one place so app.ts stays free of routing logic.
 *
 * Auth model:
 *   - /health, /health/*, /metrics                — public (k8s probes + Prometheus)
 *   - /api/v1/agents/:taskId/{status,result,approval}  — public (agent reporter
 *                                                       protocol; in-cluster
 *                                                       network policy provides
 *                                                       isolation, no human caller)
 *   - /api/v1/events/webhook, /api/v1/github/webhook   — public (external sources)
 *   - everything else under /api/v1                — gated by authMiddleware,
 *                                                    mutating routes additionally
 *                                                    require requireAdmin
 */

import { Router } from 'express';
import metricsRouter from './metrics';
import inventoryRouter from './inventory';
import proxmoxRouter from './proxmox';
import argoCDRouter from './argocd';
import eventsRouter from './events';
import prometheusRouter from './prometheus';
import kubernetesRouter from './kubernetes';
import agentsRouter from './agents';
import githubRouter from './github';
import meRouter from './me';
import { authMiddleware } from '../../middleware/auth';

const routes = Router();

// Health and metrics endpoints (no version prefix, no auth — Prometheus + probes)
routes.use(metricsRouter);

// Versioned API routes
const apiV1Router = Router();

// Agent reporter callbacks + external webhooks bypass user auth: they're
// agent-to-MC traffic over the cluster network (NetworkPolicy gates them) and
// external webhook senders (GitHub, notification-service) which authenticate
// per-route.
apiV1Router.use('/agents', agentsRouter);
apiV1Router.use('/events', eventsRouter);
apiV1Router.use('/github/webhook', githubRouter);

// Everything below this line is gated by authMiddleware (sets req.user from
// oauth2-proxy headers or MOCK_USER_EMAIL fallback).
apiV1Router.use(authMiddleware);

apiV1Router.use('/me', meRouter);
apiV1Router.use('/inventory', inventoryRouter);
apiV1Router.use('/proxmox', proxmoxRouter);
apiV1Router.use('/argocd', argoCDRouter);
apiV1Router.use('/prometheus', prometheusRouter);
apiV1Router.use('/kubernetes', kubernetesRouter);

routes.use('/api/v1', apiV1Router);

export default routes;
