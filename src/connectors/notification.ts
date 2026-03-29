/**
 * Notification Service Connector
 * Publishes infrastructure events to the notification-service for fan-out
 * to Discord webhooks and webhook subscribers.
 */

import type { InfraEventInput } from '@petedio/shared';
import { logger } from '../utils/logger';
import { notificationPublishTotal, notificationPublishDuration } from '../metrics';

export type { InfraEventInput };

export class NotificationClient {
  private baseUrl: string;
  private timeout = 5000;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl ||
      process.env.NOTIFICATION_SERVICE_URL ||
      'http://notification-service:3002';

    logger.info('Notification client initialized', { baseUrl: this.baseUrl });
  }

  /**
   * Publish an event to the notification service.
   * Fire-and-forget: logs errors but never throws.
   */
  async publishEvent(event: InfraEventInput): Promise<void> {
    const end = notificationPublishDuration.startTimer();
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      notificationPublishTotal.inc({ status: 'success' });
      logger.debug('Event published to notification service', {
        source: event.source,
        type: event.type,
        severity: event.severity,
      });
    } catch (error) {
      notificationPublishTotal.inc({ status: 'error' });
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to publish event to notification service', {
        error: msg,
        source: event.source,
        type: event.type,
      });
    } finally {
      end();
    }
  }

  /**
   * Test connection to notification service
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.timeout),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check if notification service URL is configured
   */
  static isConfigured(): boolean {
    return !!process.env.NOTIFICATION_SERVICE_URL;
  }
}
