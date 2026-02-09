/**
 * Agentics Execution Engine - Span and Graph Type Definitions
 *
 * Defines the hierarchical execution span contracts:
 *   Execution -> Core -> Repo -> Agent
 */

// ============================================================================
// Enums / Union Types
// ============================================================================

/** Span types in the hierarchy */
export type SpanType = 'core' | 'repo' | 'agent';

/** Span completion status */
export type SpanStatus = 'SUCCESS' | 'FAILED' | 'PARTIAL';

// ============================================================================
// Evidence and Artifacts
// ============================================================================

/**
 * Machine-verifiable evidence reference.
 * At least one of id, hash, or uri must be present.
 */
export interface EvidenceReference {
  id?: string;
  hash?: string;
  uri?: string;
  description?: string;
}

/**
 * Artifact attached to a span at the lowest possible level.
 */
export interface SpanArtifact {
  name: string;
  type: string;
  evidence: EvidenceReference;
  data?: unknown;
}

// ============================================================================
// Execution Spans
// ============================================================================

/**
 * Base execution span - all span types share these fields.
 */
export interface ExecutionSpanBase {
  span_id: string;
  parent_span_id: string | null;
  type: SpanType;
  name: string;
  status: SpanStatus;
  start_time: string;
  end_time?: string;
  error?: string;
  artifacts: SpanArtifact[];
  metadata?: Record<string, unknown>;
}

/**
 * Agent span: returned by instrumented repos inside their AdapterResponse.
 */
export interface AgentExecutionSpan extends ExecutionSpanBase {
  type: 'agent';
}

/**
 * Repo span: created for each adapter invocation.
 */
export interface RepoExecutionSpan extends ExecutionSpanBase {
  type: 'repo';
  repo_name: string;
  children: AgentExecutionSpan[];
}

/**
 * Core span: top-level span created by GovernanceCore on method entry.
 */
export interface CoreExecutionSpan extends ExecutionSpanBase {
  type: 'core';
  children: RepoExecutionSpan[];
}

/** Union of all span types */
export type ExecutionSpan = CoreExecutionSpan | RepoExecutionSpan | AgentExecutionSpan;

// ============================================================================
// Execution Graph
// ============================================================================

/**
 * Full hierarchical tree of spans for one GovernanceCore invocation.
 * Returned on success, partial failure, AND total failure.
 */
export interface ExecutionGraph {
  root: CoreExecutionSpan;
  total_spans: number;
  status: SpanStatus;
}

/**
 * Wraps the domain result alongside the execution graph.
 */
export interface CoreExecutionResult<T> {
  result?: T;
  execution: ExecutionGraph;
}

// ============================================================================
// Adapter Span Payload
// ============================================================================

/**
 * What an instrumented adapter returns inside AdapterResponse.metadata.
 * Legacy adapters will not have this field.
 */
export interface AdapterExecutionSpans {
  spans: AgentExecutionSpan[];
}

/**
 * Type guard: checks if AdapterResponse.metadata contains execution spans.
 */
export function hasExecutionSpans(
  metadata: Record<string, unknown> | undefined
): metadata is Record<string, unknown> & { execution: AdapterExecutionSpans } {
  if (!metadata || typeof metadata !== 'object') return false;
  const exec = (metadata as Record<string, unknown>).execution;
  if (!exec || typeof exec !== 'object') return false;
  return Array.isArray((exec as Record<string, unknown>).spans);
}
