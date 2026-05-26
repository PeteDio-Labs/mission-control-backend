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
import plansRouter from './plans';
import discordRouter from './discord';
import alertmanagerRouter from './alertmanager';
import settingsRouter from './settings';
import discordIdentitiesRouter from './discord-identities';
import roadmapRouter from './roadmap';
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

// PB.13: Alertmanager webhook → Plan service. External sender, no user;
// optional Bearer auth via ALERTMANAGER_WEBHOOK_TOKEN handled per-route.
apiV1Router.use('/alerts/alertmanager', alertmanagerRouter);

// Pete Bot v2 (PB.3): /plans mixes agent-callbacks (POST, PATCH /:id/status)
// with user-facing GETs — per-route authMiddleware inside plansRouter.
// /discord/callback uses HMAC auth (Pete Bot is the trusted client).
apiV1Router.use('/plans', plansRouter);
apiV1Router.use('/discord', discordRouter);

// Everything below this line is gated by authMiddleware (sets req.user from
// oauth2-proxy headers or MOCK_USER_EMAIL fallback).
apiV1Router.use(authMiddleware);

apiV1Router.use('/me', meRouter);
apiV1Router.use('/inventory', inventoryRouter);
apiV1Router.use('/proxmox', proxmoxRouter);
apiV1Router.use('/argocd', argoCDRouter);
apiV1Router.use('/prometheus', prometheusRouter);
apiV1Router.use('/kubernetes', kubernetesRouter);

// PB.12 — MC Settings UI surfaces. Read endpoints are auth-only; mutating
// endpoints add requireAdmin per-route inside each router.
apiV1Router.use('/settings', settingsRouter);
apiV1Router.use('/discord-identities', discordIdentitiesRouter);

// Roadmap (kanban) — MC-managed master plan items. All routes require auth;
// mutating routes additionally require requireAdmin (enforced inside the router).
// Sibling to /plans but with a different lifecycle and admin-only model.
apiV1Router.use('/roadmap', roadmapRouter);

routes.use('/api/v1', apiV1Router);

export default routes;
