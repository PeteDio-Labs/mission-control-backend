/**
 * Route index
 * Mounts all API routers in one place so app.ts stays free of routing logic.
 */

import { Router } from 'express';
import metricsRouter from './metrics';
import inventoryRouter from './inventory';
import proxmoxRouter from './proxmox';
import argoCDRouter from './argocd';
import eventsRouter from './events';
import qbittorrentRouter from './qbittorrent';
import prometheusRouter from './prometheus';
import kubernetesRouter from './kubernetes';
import agentsRouter from './agents';

const routes = Router();

// Health and metrics endpoints (no version prefix)
routes.use(metricsRouter);

// Versioned API routes
const apiV1Router = Router();
apiV1Router.use('/inventory', inventoryRouter);
apiV1Router.use('/proxmox', proxmoxRouter);
apiV1Router.use('/argocd', argoCDRouter);
apiV1Router.use('/events', eventsRouter);
apiV1Router.use('/qbittorrent', qbittorrentRouter);
apiV1Router.use('/prometheus', prometheusRouter);
apiV1Router.use('/kubernetes', kubernetesRouter);
apiV1Router.use('/agents', agentsRouter);

routes.use('/api/v1', apiV1Router);

export default routes;
