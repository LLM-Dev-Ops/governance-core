/**
 * LLM-Governance-Core Adapter Interfaces
 *
 * This file defines thin glue-layer interfaces for integrating with external services.
 * Each adapter interface is minimal (2-4 methods) and focused on delegation, not re-implementation.
 */

// ============================================================================
// Core Types
// ============================================================================

export interface AdapterConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
}

export interface AdapterResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// LLM-CostOps Adapter (12) - Cost Accounting and Forecasting
// ============================================================================

export interface CostMetrics {
  totalCost: number;
  currency: string;
  period: {
    start: Date;
    end: Date;
  };
  breakdown: Record<string, number>;
}

export interface CostForecast {
  projectedCost: number;
  confidence: number;
  period: {
    start: Date;
    end: Date;
  };
}

export interface ICostOpsAdapter {
  /**
   * Report usage metrics to CostOps for accounting
   */
  reportUsage(metrics: {
    service: string;
    tokens: number;
    requestId: string;
    timestamp: Date;
    metadata?: Record<string, unknown>;
  }): Promise<AdapterResponse<void>>;

  /**
   * Query current cost metrics
   */
  getCostMetrics(filters: {
    startDate: Date;
    endDate: Date;
    services?: string[];
    groupBy?: string[];
  }): Promise<AdapterResponse<CostMetrics>>;

  /**
   * Get cost forecast for planning
   */
  getForecast(params: {
    horizon: number; // days
    services?: string[];
  }): Promise<AdapterResponse<CostForecast>>;
}

// ============================================================================
// LLM-Governance-Dashboard Adapter (13) - Governance Visibility and Reporting
// ============================================================================

export interface GovernanceEvent {
  eventType: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  timestamp: Date;
  details: Record<string, unknown>;
  correlationId?: string;
}

export interface DashboardMetrics {
  policyViolations: number;
  activeRequests: number;
  totalCost: number;
  uptimePercent: number;
}

export interface IGovernanceDashboardAdapter {
  /**
   * Publish governance events for dashboard visibility
   */
  publishEvent(event: GovernanceEvent): Promise<AdapterResponse<void>>;

  /**
   * Send aggregated metrics to dashboard
   */
  publishMetrics(metrics: DashboardMetrics): Promise<AdapterResponse<void>>;

  /**
   * Query dashboard for health status
   */
  getHealthStatus(): Promise<AdapterResponse<{ healthy: boolean; details: Record<string, unknown> }>>;
}

// ============================================================================
// LLM-Policy-Engine Adapter (14) - Declarative Access, Security, and Cost Policies
// ============================================================================

export interface PolicyEvaluationRequest {
  principal: string; // user/service identifier
  action: string; // e.g., "llm:invoke", "llm:stream"
  resource: string; // e.g., "model:gpt-4"
  context: Record<string, unknown>; // request context (cost, rate, etc.)
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  reasons: string[];
  appliedPolicies: string[];
  conditions?: Record<string, unknown>;
}

export interface IPolicyEngineAdapter {
  /**
   * Evaluate if a request is allowed by current policies
   */
  evaluatePolicy(request: PolicyEvaluationRequest): Promise<AdapterResponse<PolicyEvaluationResult>>;

  /**
   * Validate policy definitions (called during policy updates)
   */
  validatePolicy(policyDefinition: Record<string, unknown>): Promise<AdapterResponse<{ valid: boolean; errors: string[] }>>;

  /**
   * Refresh cached policies from Policy Engine
   */
  refreshPolicies(): Promise<AdapterResponse<void>>;
}

// ============================================================================
// LLM-Analytics-Hub Adapter (17) - Unified Analytics Aggregation
// ============================================================================

export interface AnalyticsEvent {
  eventName: string;
  timestamp: Date;
  properties: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
}

export interface AnalyticsQuery {
  metric: string;
  dimensions?: string[];
  filters?: Record<string, unknown>;
  timeRange: {
    start: Date;
    end: Date;
  };
}

export interface IAnalyticsHubAdapter {
  /**
   * Send analytics events to the hub
   */
  track(event: AnalyticsEvent): Promise<AdapterResponse<void>>;

  /**
   * Query aggregated analytics data
   */
  query(query: AnalyticsQuery): Promise<AdapterResponse<Record<string, unknown>>>;

  /**
   * Batch send multiple events for efficiency
   */
  trackBatch(events: AnalyticsEvent[]): Promise<AdapterResponse<void>>;
}

// ============================================================================
// LLM-Config-Manager Adapter (18) - Centralized Configuration and Secrets
// ============================================================================

export interface ConfigValue {
  key: string;
  value: unknown;
  version: string;
  lastUpdated: Date;
}

export interface IConfigManagerAdapter {
  /**
   * Get configuration value by key
   */
  getConfig(key: string): Promise<AdapterResponse<ConfigValue>>;

  /**
   * Get secret value (credentials, API keys, etc.)
   */
  getSecret(secretName: string): Promise<AdapterResponse<string>>;

  /**
   * Watch for configuration changes
   */
  watchConfig(keys: string[], callback: (changes: ConfigValue[]) => void): Promise<AdapterResponse<{ watchId: string }>>;

  /**
   * Stop watching configuration changes
   */
  unwatchConfig(watchId: string): Promise<AdapterResponse<void>>;
}

// ============================================================================
// LLM-Schema-Registry Adapter (19) - Canonical Governance and Audit Data Contracts
// ============================================================================

export interface SchemaDefinition {
  schemaId: string;
  version: string;
  schema: Record<string, unknown>; // JSON Schema or similar
  format: 'json-schema' | 'protobuf' | 'avro';
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
  }>;
}

export interface ISchemaRegistryAdapter {
  /**
   * Get schema definition for validation
   */
  getSchema(schemaId: string, version?: string): Promise<AdapterResponse<SchemaDefinition>>;

  /**
   * Validate data against registered schema
   */
  validate(schemaId: string, data: unknown): Promise<AdapterResponse<ValidationResult>>;

  /**
   * Register or update a schema
   */
  registerSchema(schema: SchemaDefinition): Promise<AdapterResponse<{ schemaId: string; version: string }>>;
}

// ============================================================================
// Adapter Collection
// ============================================================================

/**
 * Collection of all adapters used by LLM-Governance-Core
 * This type ensures all required adapters are available at runtime
 */
export interface AdapterCollection {
  costOps: ICostOpsAdapter;
  dashboard: IGovernanceDashboardAdapter;
  policyEngine: IPolicyEngineAdapter;
  analyticsHub: IAnalyticsHubAdapter;
  configManager: IConfigManagerAdapter;
  schemaRegistry: ISchemaRegistryAdapter;
}

/**
 * Factory function type for creating adapter instances
 */
export type AdapterFactory<T> = (config: AdapterConfig) => T;

/**
 * Registry of adapter factories for dependency injection
 */
export interface AdapterFactoryRegistry {
  costOps: AdapterFactory<ICostOpsAdapter>;
  dashboard: AdapterFactory<IGovernanceDashboardAdapter>;
  policyEngine: AdapterFactory<IPolicyEngineAdapter>;
  analyticsHub: AdapterFactory<IAnalyticsHubAdapter>;
  configManager: AdapterFactory<IConfigManagerAdapter>;
  schemaRegistry: AdapterFactory<ISchemaRegistryAdapter>;
}
