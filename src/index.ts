import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { db } from './db/client';
import { KubernetesConnector } from './connectors/kubernetes';
import { ProxmoxConnector } from './connectors/proxmox';
import { ArgoCDConnector } from './connectors/argocd';
import { PrometheusConnector } from './connectors/prometheus';
import { NotificationClient } from './connectors/notification';
import { QBittorrentConnector } from './connectors/qbittorrent';
import { syncDiscoveredInventory } from './db/inventory';
import app from './app';
import {
  appUp,
  kubernetesAvailable,
  proxmoxAvailable,
  argoCdAvailable,
  prometheusAvailable,
} from './metrics/index';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;

// Start server
let server: ReturnType<typeof app.listen>;

async function startServer() {
  try {
    // Initialize database connection
    await db.connect();
    logger.info('✅ Database connection established');

    const connector = new KubernetesConnector(process.env.KUBECONFIG_PATH);
    await connector.initialize();
    app.locals.kubernetesConnector = connector;
    kubernetesAvailable.set(1);
    logger.info('✅ Kubernetes connector initialized');

    if (
      process.env.PROXMOX_HOST &&
      process.env.PROXMOX_TOKEN_ID &&
      process.env.PROXMOX_TOKEN_SECRET
    ) {
      const proxmoxConnector = new ProxmoxConnector();
      await proxmoxConnector.initialize();
      app.locals.proxmoxConnector = proxmoxConnector;
      proxmoxAvailable.set(1);
      logger.info('✅ Proxmox connector initialized');
    } else {
      logger.info('ℹ️ Proxmox connector skipped (missing credentials)');
    }

    // Initialize ArgoCD connector (optional)
    if (ArgoCDConnector.isConfigured()) {
      const argoCDConnector = new ArgoCDConnector();
      const connected = await argoCDConnector.testConnection();
      if (connected) {
        app.locals.argoCDConnector = argoCDConnector;
        argoCdAvailable.set(1);
        logger.info('✅ ArgoCD connector initialized');
      } else {
        argoCdAvailable.set(0);
        logger.warn('⚠️ ArgoCD connector failed connection test');
      }
    } else {
      logger.info('ℹ️ ArgoCD connector skipped (missing credentials)');
    }

    // Initialize Prometheus connector (optional)
    if (PrometheusConnector.isConfigured()) {
      const prometheusConnector = new PrometheusConnector();
      const connected = await prometheusConnector.testConnection();
      if (connected) {
        app.locals.prometheusConnector = prometheusConnector;
        prometheusAvailable.set(1);
        logger.info('✅ Prometheus connector initialized');
      } else {
        prometheusAvailable.set(0);
        logger.warn('⚠️ Prometheus connector failed connection test');
      }
    } else {
      logger.info('ℹ️ Prometheus connector skipped (missing configuration)');
    }

    // Initialize qBittorrent connector (optional)
    if (QBittorrentConnector.isConfigured()) {
      const qbittorrentConnector = new QBittorrentConnector();
      const connected = await qbittorrentConnector.testConnection();
      if (connected) {
        app.locals.qbittorrentConnector = qbittorrentConnector;
        logger.info('✅ qBittorrent connector initialized');
      } else {
        // Still store it — torrents will be available when qBit comes up
        app.locals.qbittorrentConnector = qbittorrentConnector;
        logger.warn('⚠️ qBittorrent not reachable (will retry on request)');
      }
    } else {
      logger.info('ℹ️ qBittorrent connector skipped (QBIT_HOST not set)');
    }

    // Initialize Notification Service client (optional)
    if (NotificationClient.isConfigured()) {
      const notificationClient = new NotificationClient();
      const connected = await notificationClient.testConnection();
      if (connected) {
        app.locals.notificationClient = notificationClient;
        logger.info('✅ Notification service client initialized');

        // Register as webhook subscriber for SSE relay
        try {
          const notifUrl = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3002';
          const backendUrl = `http://mission-control-backend.mission-control.svc.cluster.local:${PORT}`;
          const subResponse = await fetch(`${notifUrl}/api/v1/subscriptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: `${backendUrl}/api/v1/events/webhook`,
              name: 'mc-backend-sse',
              events: ['*'],
              active: true,
            }),
          });
          const subData = (await subResponse.json()) as Record<string, unknown>;
          logger.info('✅ Registered as webhook subscriber for SSE relay', {
            subscriptionId: subData?.id,
          });
        } catch (subError) {
          const msg = subError instanceof Error ? subError.message : 'Unknown error';
          logger.warn('⚠️ Failed to register webhook subscription (SSE relay will not receive events)', { error: msg });
        }
      } else {
        // Still store it — events will be published when service comes up
        app.locals.notificationClient = notificationClient;
        logger.warn('⚠️ Notification service not reachable (will retry on publish)');
      }
    } else {
      logger.info('ℹ️ Notification service client skipped (NOTIFICATION_SERVICE_URL not set)');
    }

    const syncIntervalMs = Number(process.env.INVENTORY_SYNC_INTERVAL_MS || 60000);
    if (syncIntervalMs > 0) {
      setInterval(async () => {
        try {
          logger.info('⏱️ Running scheduled inventory sync');
          const proxmoxConnector = app.locals
            .proxmoxConnector as ProxmoxConnector | undefined;

          const [k8sInventory, proxmoxInventory] = await Promise.all([
            connector.discoverAll(),
            proxmoxConnector?.discoverAll() ?? Promise.resolve({ hosts: [], workloads: [] }),
          ]);

          const merged = {
            hosts: [...k8sInventory.hosts, ...proxmoxInventory.hosts],
            workloads: [...k8sInventory.workloads, ...proxmoxInventory.workloads],
          };

          const stats = await syncDiscoveredInventory(merged);
          logger.info('✅ Scheduled inventory sync complete', stats);
        } catch (error) {
          logger.error('Scheduled inventory sync failed', error);
        }
      }, syncIntervalMs);
    }

    server = app.listen(PORT, () => {
      appUp.set(1);
      logger.info(`🚀 Mission Control Backend listening on port ${PORT}`);
      logger.info(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Close HTTP server
  server.close(async () => {
    logger.info('HTTP server closed');

    // Close database connections
    try {
      await db.disconnect();
      logger.info('Database connections closed');
    } catch (error) {
      logger.error('Error closing database connections:', error);
    }

    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
