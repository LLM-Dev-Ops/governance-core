/**
 * Agentics Execution Engine - Span Creation Utilities
 *
 * Pure functions for span lifecycle management.
 */

import { randomUUID } from 'node:crypto';
import type {
  CoreExecutionSpan,
  RepoExecutionSpan,
  AgentExecutionSpan,
  SpanStatus,
  SpanArtifact,
  EvidenceReference,
} from './types';

// ============================================================================
// UUID and Timestamp
// ============================================================================

export function generateSpanId(): string {
  return randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ============================================================================
// Span Factories
// ============================================================================

export function createCoreSpan(
  name: string,
  parentSpanId: string | null
): CoreExecutionSpan {
  return {
    span_id: generateSpanId(),
    parent_span_id: parentSpanId,
    type: 'core',
    name,
    status: 'SUCCESS',
    start_time: nowISO(),
    artifacts: [],
    children: [],
  };
}

export function createRepoSpan(
  repoName: string,
  parentSpanId: string
): RepoExecutionSpan {
  return {
    span_id: generateSpanId(),
    parent_span_id: parentSpanId,
    type: 'repo',
    name: `adapter:${repoName}`,
    repo_name: repoName,
    status: 'SUCCESS',
    start_time: nowISO(),
    artifacts: [],
    children: [],
  };
}

// ============================================================================
// Span Closing
// ============================================================================

/**
 * Closes a span by setting end_time and final status. Mutates in-place.
 */
export function closeSpan<T extends CoreExecutionSpan | RepoExecutionSpan | AgentExecutionSpan>(
  span: T,
  status: SpanStatus,
  error?: string
): T {
  span.end_time = nowISO();
  span.status = status;
  if (error) {
    span.error = error;
  }
  return span;
}

// ============================================================================
// Artifact Helpers
// ============================================================================

/**
 * Creates an artifact with a validated evidence reference.
 * Throws if none of id, hash, or uri is present.
 */
export function createArtifact(
  name: string,
  type: string,
  evidence: EvidenceReference,
  data?: unknown
): SpanArtifact {
  if (!evidence.id && !evidence.hash && !evidence.uri) {
    throw new Error(
      `Artifact "${name}" requires at least one evidence reference (id, hash, or uri)`
    );
  }
  return { name, type, evidence, data };
}

// ============================================================================
// Span Counting
// ============================================================================

export function countSpans(core: CoreExecutionSpan): number {
  let count = 1;
  for (const repo of core.children) {
    count += 1;
    count += repo.children.length;
  }
  return count;
}
