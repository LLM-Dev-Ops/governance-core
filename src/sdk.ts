/**
 * LLM-Governance-Core SDK
 *
 * Public API surface for the governance orchestration layer.
 * This module re-exports all public types, classes, and utilities for consumer applications.
 */

// ============================================================================
// Version
// ============================================================================

export const VERSION = '1.0.0';

// ============================================================================
// Core Class and Factory
// ============================================================================

export { GovernanceCore, createGovernanceCore } from './lib';
export type { ExecutionOptions } from './lib';

// ============================================================================
// Core Types
// ============================================================================

export type {
  GovernanceRequest,
  GovernanceDecision,
  PolicyEvaluationResult,
  FinOpsSummary,
  AuditSignal,
  RBACContext,
} from './types';

// ============================================================================
// Adapter Interfaces
// ============================================================================

export type {
  AdapterCollection,
  ICostOpsAdapter,
  IPolicyEngineAdapter,
  IGovernanceDashboardAdapter,
  IAnalyticsHubAdapter,
  IConfigManagerAdapter,
  ISchemaRegistryAdapter,
  AdapterConfig,
  AdapterResponse,
} from './adapters';

// ============================================================================
// Services
// ============================================================================

export {
  PolicyCoordinationService,
  AuditAggregationService,
  FinOpsOrchestrationService,
} from './services';

// ============================================================================
// Execution Spans (Agentics Execution Engine)
// ============================================================================

export type {
  SpanType,
  SpanStatus,
  EvidenceReference,
  SpanArtifact,
  ExecutionSpanBase,
  CoreExecutionSpan,
  RepoExecutionSpan,
  AgentExecutionSpan,
  ExecutionSpan,
  ExecutionGraph,
  CoreExecutionResult,
  AdapterExecutionSpans,
} from './execution/types';

export { hasExecutionSpans } from './execution/types';
export { ExecutionContext } from './execution/context';
export {
  generateSpanId,
  createCoreSpan,
  createRepoSpan,
  closeSpan,
  createArtifact,
  countSpans,
} from './execution/spans';

// ============================================================================
// Default Export
// ============================================================================

export { GovernanceCore as default } from './lib';
