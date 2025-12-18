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
// Default Export
// ============================================================================

export { GovernanceCore as default } from './lib';
