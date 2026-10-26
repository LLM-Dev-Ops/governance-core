/**
 * Assembles the AdapterCollection from environment configuration.
 *
 * The three adapters the gate hard-invokes — policy engine, CostOps, governance
 * dashboard — plus the analytics hub must all have an explicit URL. There is no
 * built-in default: a process that cannot reach its policy authority must refuse
 * to start rather than boot into a state where the gate cannot evaluate.
 */

import type { AdapterCollection } from './index';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type HttpAdapterOptions,
} from './http/client';
import { HttpAnalyticsHubAdapter } from './http/analytics-hub';
import { HttpCostOpsAdapter, type CostOpsPaths } from './http/cost-ops';
import { HttpGovernanceDashboardAdapter } from './http/dashboard';
import { HttpPolicyEngineAdapter } from './http/policy-engine';
import { UnconfiguredConfigManagerAdapter, UnconfiguredSchemaRegistryAdapter } from './unconfigured';

export interface UpstreamConfig {
  policyEngineUrl: string;
  costOpsUrl: string;
  dashboardUrl: string;
  analyticsHubUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
  costOpsPaths: CostOpsPaths;
}

const REQUIRED_URLS = [
  ['policyEngineUrl', 'POLICY_ENGINE_URL'],
  ['costOpsUrl', 'COSTOPS_URL'],
  ['dashboardUrl', 'GOVERNANCE_DASHBOARD_URL'],
  ['analyticsHubUrl', 'ANALYTICS_HUB_URL'],
] as const;

export class UpstreamConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamConfigurationError';
  }
}

function readUrl(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new UpstreamConfigurationError(`${name} is not a valid http(s) URL: "${raw}"`);
  }
  return raw;
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UpstreamConfigurationError(
      `${name} must be a positive integer, got "${raw}"`
    );
  }
  return parsed;
}

/**
 * Reads upstream configuration from the environment.
 * Throws UpstreamConfigurationError when a mandatory value is absent or malformed.
 */
export function resolveUpstreamConfig(env: NodeJS.ProcessEnv = process.env): UpstreamConfig {
  const resolved: Partial<Record<(typeof REQUIRED_URLS)[number][0], string>> = {};
  const missing: string[] = [];

  for (const [field, envVar] of REQUIRED_URLS) {
    const value = readUrl(env, envVar);
    if (!value) {
      missing.push(envVar);
    } else {
      resolved[field] = value;
    }
  }

  if (missing.length > 0) {
    throw new UpstreamConfigurationError(
      `Refusing to start: mandatory upstream URL(s) not configured: ${missing.join(', ')}. ` +
        'The governance gate cannot evaluate without them and will not fall back to an allow.'
    );
  }

  return {
    policyEngineUrl: resolved.policyEngineUrl!,
    costOpsUrl: resolved.costOpsUrl!,
    dashboardUrl: resolved.dashboardUrl!,
    analyticsHubUrl: resolved.analyticsHubUrl!,
    timeoutMs: readPositiveInteger(
      env,
      'GOVERNANCE_UPSTREAM_TIMEOUT_MS',
      DEFAULT_UPSTREAM_TIMEOUT_MS
    ),
    maxResponseBytes: readPositiveInteger(
      env,
      'GOVERNANCE_UPSTREAM_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES
    ),
    costOpsPaths: {
      events: env.COSTOPS_EVENTS_PATH?.trim() || undefined,
      metrics: env.COSTOPS_METRICS_PATH?.trim() || undefined,
      forecast: env.COSTOPS_FORECAST_PATH?.trim() || undefined,
    },
  };
}

export function createAdapterCollection(env: NodeJS.ProcessEnv = process.env): AdapterCollection {
  const config = resolveUpstreamConfig(env);
  const opts = (baseUrl: string): HttpAdapterOptions => ({
    baseUrl,
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
  });

  return {
    policyEngine: new HttpPolicyEngineAdapter(opts(config.policyEngineUrl)),
    costOps: new HttpCostOpsAdapter(opts(config.costOpsUrl), config.costOpsPaths),
    dashboard: new HttpGovernanceDashboardAdapter(opts(config.dashboardUrl)),
    analyticsHub: new HttpAnalyticsHubAdapter(opts(config.analyticsHubUrl)),
    configManager: new UnconfiguredConfigManagerAdapter(),
    schemaRegistry: new UnconfiguredSchemaRegistryAdapter(),
  };
}
