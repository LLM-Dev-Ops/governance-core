/**
 * Concrete IGovernanceDashboardAdapter over GOVERNANCE_DASHBOARD_URL.
 *
 * `getHealthStatus` is hard-invoked by the gate (src/lib.ts:407-416), so an
 * unreachable dashboard denies the gate rather than degrading it.
 */

import type {
  AdapterResponse,
  DashboardMetrics,
  GovernanceEvent,
  IGovernanceDashboardAdapter,
} from '../index';
import { acknowledged, asRecord, getJson, postJson, type HttpAdapterOptions } from './client';

export const DASHBOARD_EVENTS_PATH = '/api/v1/events';
export const DASHBOARD_METRICS_PATH = '/api/v1/metrics';
export const DASHBOARD_HEALTH_PATH = '/health';

function parseHealth(body: unknown): { healthy: boolean; details: Record<string, unknown> } | null {
  const record = asRecord(body);
  if (!record) return null;

  if (typeof record.healthy === 'boolean') {
    return { healthy: record.healthy, details: asRecord(record.details) ?? {} };
  }
  // Cloud Run health endpoints in this estate report `{status: "healthy"}`.
  if (typeof record.status === 'string') {
    return { healthy: record.status.toLowerCase() === 'healthy', details: record };
  }
  return null;
}

export class HttpGovernanceDashboardAdapter implements IGovernanceDashboardAdapter {
  constructor(private readonly options: HttpAdapterOptions) {}

  publishEvent(event: GovernanceEvent): Promise<AdapterResponse<void>> {
    return postJson(
      this.options,
      DASHBOARD_EVENTS_PATH,
      {
        source: 'governance-core',
        event_type: event.eventType,
        severity: event.severity,
        timestamp: event.timestamp.toISOString(),
        details: event.details,
        correlation_id: event.correlationId,
      },
      acknowledged
    );
  }

  publishMetrics(metrics: DashboardMetrics): Promise<AdapterResponse<void>> {
    return postJson(this.options, DASHBOARD_METRICS_PATH, metrics, acknowledged);
  }

  getHealthStatus(): Promise<AdapterResponse<{ healthy: boolean; details: Record<string, unknown> }>> {
    return getJson(this.options, DASHBOARD_HEALTH_PATH, parseHealth);
  }
}
