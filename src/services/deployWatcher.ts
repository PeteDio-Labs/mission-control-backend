/**
 * Deploy Watcher
 * Polls Kubernetes every POLL_INTERVAL_MS for deployment image changes.
 * Publishes a deploy event to notification-service for each change detected.
 * This is what triggers the blog-agent content pipeline on new deploys.
 */

import { logger } from '../utils/logger';
import type { KubernetesConnector } from '../connectors/kubernetes';
import type { NotificationClient } from '../connectors/notification';

const POLL_INTERVAL_MS = parseInt(process.env.DEPLOY_WATCHER_INTERVAL_MS || '60000', 10);

// namespace/name → image
type ImageSnapshot = Map<string, string>;

export class DeployWatcher {
  private snapshot: ImageSnapshot = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(
    private k8s: KubernetesConnector,
    private notifications: NotificationClient,
  ) {}

  start(): void {
    logger.info(`DeployWatcher started — polling every ${POLL_INTERVAL_MS / 1000}s`);
    // Seed initial snapshot without publishing events
    this.poll(true).catch((err) =>
      logger.warn('DeployWatcher: initial snapshot failed', { error: err instanceof Error ? err.message : String(err) })
    );
    this.timer = setInterval(() => {
      this.poll(false).catch((err) =>
        logger.warn('DeployWatcher: poll failed', { error: err instanceof Error ? err.message : String(err) })
      );
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(seed: boolean): Promise<void> {
    const deployments = await this.k8s.discoverDeployments();
    const current: ImageSnapshot = new Map();

    for (const d of deployments) {
      const key = `${d.namespace}/${d.name}`;
      // image is in spec.containers[0].image per convertDeploymentToWorkload
      const containers = (d.spec as Record<string, unknown> | undefined)?.containers as Array<{ name: string; image: string }> | undefined;
      const image = containers?.[0]?.image;
      if (image) current.set(key, image);
    }

    if (seed) {
      this.snapshot = current;
      this.initialized = true;
      logger.info(`DeployWatcher: seeded snapshot with ${current.size} deployments`);
      return;
    }

    if (!this.initialized) return;

    for (const [key, image] of current) {
      const prev = this.snapshot.get(key);
      if (prev !== undefined && prev !== image) {
        const [namespace, name] = key.split('/') as [string, string];
        logger.info(`DeployWatcher: image change detected — ${key}: ${prev.slice(-20)} → ${image.slice(-20)}`);
        this.notifications.publishEvent({
          source: 'kubernetes',
          type: 'deployment',
          severity: 'info',
          message: `Deployment updated: ${name} in ${namespace} → ${image}`,
          namespace,
          affected_service: name,
          metadata: { image, previousImage: prev },
        });
      }
    }

    this.snapshot = current;
  }
}
