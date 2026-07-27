/**
 * Concrete IAnalyticsHubAdapter over ANALYTICS_HUB_URL.
 *
 * Analytics is advisory — the gate does not invoke it — but the calls are still
 * awaited and response-checked so that `exportArtifacts` reports honestly.
 */

import type {
  AdapterResponse,
  AnalyticsEvent,
  AnalyticsQuery,
  IAnalyticsHubAdapter,
} from '../index';
import { acknowledged, asRecord, postJson, type HttpAdapterOptions } from './client';

export const ANALYTICS_EVENTS_PATH = '/api/v1/events';
export const ANALYTICS_QUERY_PATH = '/api/v1/query';

function serialize(event: AnalyticsEvent): Record<string, unknown> {
  return {
    source: 'governance-core',
    event: event.eventName,
    timestamp: event.timestamp.toISOString(),
    properties: event.properties,
    user_id: event.userId,
    session_id: event.sessionId,
  };
}

export class HttpAnalyticsHubAdapter implements IAnalyticsHubAdapter {
  constructor(private readonly options: HttpAdapterOptions) {}

  track(event: AnalyticsEvent): Promise<AdapterResponse<void>> {
    return postJson(this.options, ANALYTICS_EVENTS_PATH, serialize(event), acknowledged);
  }

  query(query: AnalyticsQuery): Promise<AdapterResponse<Record<string, unknown>>> {
    return postJson(
      this.options,
      ANALYTICS_QUERY_PATH,
      {
        metric: query.metric,
        dimensions: query.dimensions ?? [],
        filters: query.filters ?? {},
        start: query.timeRange.start.toISOString(),
        end: query.timeRange.end.toISOString(),
      },
      asRecord
    );
  }

  trackBatch(events: AnalyticsEvent[]): Promise<AdapterResponse<void>> {
    return postJson(this.options, ANALYTICS_EVENTS_PATH, { events: events.map(serialize) }, acknowledged);
  }
}
