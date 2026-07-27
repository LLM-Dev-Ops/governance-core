/**
 * Concrete ICostOpsAdapter over COSTOPS_URL.
 *
 * `COSTOPS_EVENTS_PATH` is the path the service already receives events on. The
 * metrics and forecast paths are not yet pinned to a published CostOps contract;
 * they are overridable so a deployment can point them at the real routes without
 * a code change. A wrong path yields a non-2xx, which denies the gate — it never
 * silently allows.
 */

import type {
  AdapterResponse,
  CostForecast,
  CostMetrics,
  ICostOpsAdapter,
} from '../index';
import { acknowledged, asRecord, postJson, type HttpAdapterOptions } from './client';

export const COSTOPS_EVENTS_PATH = '/api/v1/events';
export const COSTOPS_METRICS_PATH = '/api/v1/costs/query';
export const COSTOPS_FORECAST_PATH = '/api/v1/costs/forecast';

export interface CostOpsPaths {
  events?: string;
  metrics?: string;
  forecast?: string;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseMetrics(body: unknown): CostMetrics | null {
  const record = asRecord(body);
  if (!record) return null;

  const source = asRecord(record.data) ?? record;
  const totalCost = asNumber(source.totalCost ?? source.total_cost);
  if (totalCost === null) return null;

  const period = asRecord(source.period);
  return {
    totalCost,
    currency: typeof source.currency === 'string' ? source.currency : 'USD',
    period: {
      start: new Date(String(period?.start ?? new Date(0).toISOString())),
      end: new Date(String(period?.end ?? new Date().toISOString())),
    },
    breakdown: (asRecord(source.breakdown) as Record<string, number>) ?? {},
  };
}

function parseForecast(body: unknown): CostForecast | null {
  const record = asRecord(body);
  if (!record) return null;

  const source = asRecord(record.data) ?? record;
  const projectedCost = asNumber(source.projectedCost ?? source.projected_cost);
  if (projectedCost === null) return null;

  const period = asRecord(source.period);
  return {
    projectedCost,
    confidence: asNumber(source.confidence) ?? 0,
    period: {
      start: new Date(String(period?.start ?? new Date().toISOString())),
      end: new Date(String(period?.end ?? new Date().toISOString())),
    },
  };
}

export class HttpCostOpsAdapter implements ICostOpsAdapter {
  private readonly paths: Required<CostOpsPaths>;

  constructor(private readonly options: HttpAdapterOptions, paths: CostOpsPaths = {}) {
    this.paths = {
      events: paths.events ?? COSTOPS_EVENTS_PATH,
      metrics: paths.metrics ?? COSTOPS_METRICS_PATH,
      forecast: paths.forecast ?? COSTOPS_FORECAST_PATH,
    };
  }

  reportUsage(metrics: {
    service: string;
    tokens: number;
    requestId: string;
    timestamp: Date;
    metadata?: Record<string, unknown>;
  }): Promise<AdapterResponse<void>> {
    return postJson(
      this.options,
      this.paths.events,
      {
        source: 'governance-core',
        event: 'usage.reported',
        service: metrics.service,
        tokens: metrics.tokens,
        request_id: metrics.requestId,
        timestamp: metrics.timestamp.toISOString(),
        metadata: metrics.metadata ?? {},
      },
      acknowledged
    );
  }

  getCostMetrics(filters: {
    startDate: Date;
    endDate: Date;
    services?: string[];
    groupBy?: string[];
  }): Promise<AdapterResponse<CostMetrics>> {
    return postJson(
      this.options,
      this.paths.metrics,
      {
        start_date: filters.startDate.toISOString(),
        end_date: filters.endDate.toISOString(),
        services: filters.services ?? [],
        group_by: filters.groupBy ?? [],
      },
      parseMetrics
    );
  }

  getForecast(params: { horizon: number; services?: string[] }): Promise<AdapterResponse<CostForecast>> {
    return postJson(
      this.options,
      this.paths.forecast,
      { horizon_days: params.horizon, services: params.services ?? [] },
      parseForecast
    );
  }
}
