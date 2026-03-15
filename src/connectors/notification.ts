/**
 * Notification Service Connector
 * Publishes infrastructure events to the notification-service for fan-out
 * to Discord webhooks and webhook subscribers.
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { notificationPublishTotal, notificationPublishDuration } from '../metrics';

// Event types matching notification-service's InfraEventSchema
export type EventSource = 'kubernetes' | 'proxmox' | 'argocd';
export type EventType =
  | 'deployment'
  | 'pod-failure'
  | 'vm-status'
  | 'lxc-status'
  | 'sync-drift'
  | 'node-status'
  | 'rollout';
export type EventSeverity = 'info' | 'warning' | 'critical';

export interface InfraEventInput {
  source: EventSource;
  type: EventType;
  severity: EventSeverity;
  message: string;
  namespace?: string;
  affected_service?: string;
  metadata?: Record<string, unknown>;
}

export class NotificationClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl ||
      process.env.NOTIFICATION_SERVICE_URL ||
      'http://notification-service:3002';

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });

    logger.info('Notification client initialized', { baseUrl: this.baseUrl });
  }

  /**
   * Publish an event to the notification service.
   * Fire-and-forget: logs errors but never throws.
   */
  async publishEvent(event: InfraEventInput): Promise<void> {
    const end = notificationPublishDuration.startTimer();
    try {
      await this.client.post('/api/v1/events', event);
      notificationPublishTotal.inc({ status: 'success' });
      logger.debug('Event published to notification service', {
        source: event.source,
        type: event.type,
        severity: event.severity,
      });
    } catch (error) {
      notificationPublishTotal.inc({ status: 'error' });
      const msg =
        error instanceof Error ? error.message : 'Unknown error';
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
      await this.client.get('/health');
      return true;
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
