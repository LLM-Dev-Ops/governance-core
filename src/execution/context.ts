/**
 * Agentics Execution Engine - ExecutionContext
 *
 * Stateful span manager for one GovernanceCore method invocation.
 * Manages the core span, creates repo spans, collects agent spans,
 * and performs hierarchy validation.
 */

import type {
  CoreExecutionSpan,
  RepoExecutionSpan,
  ExecutionGraph,
  SpanArtifact,
  SpanStatus,
} from './types';
import { hasExecutionSpans } from './types';
import {
  createCoreSpan,
  createRepoSpan,
  closeSpan,
  countSpans,
} from './spans';
import type { AdapterResponse } from '../adapters';

export class ExecutionContext {
  private coreSpan: CoreExecutionSpan;
  private activeRepoSpans: Map<string, RepoExecutionSpan> = new Map();

  constructor(operationName: string, parentSpanId: string | null = null) {
    this.coreSpan = createCoreSpan(operationName, parentSpanId);
  }

  get coreSpanId(): string {
    return this.coreSpan.span_id;
  }

  // ============================================================================
  // Repo Span Lifecycle
  // ============================================================================

  /**
   * Opens a repo-level span for an adapter invocation.
   * Returns the span_id handle for closing.
   */
  startRepoSpan(adapterName: string): string {
    const repoSpan = createRepoSpan(adapterName, this.coreSpan.span_id);
    this.activeRepoSpans.set(repoSpan.span_id, repoSpan);
    return repoSpan.span_id;
  }

  /**
   * Closes a repo span after adapter invocation completes.
   * Extracts agent spans from AdapterResponse metadata if present.
   * Returns true if the adapter returned execution spans.
   */
  closeRepoSpan<T>(
    repoSpanId: string,
    adapterResponse: AdapterResponse<T>,
    artifacts: SpanArtifact[] = []
  ): boolean {
    const repoSpan = this.activeRepoSpans.get(repoSpanId);
    if (!repoSpan) {
      throw new Error(`No active repo span with id ${repoSpanId}`);
    }

    repoSpan.artifacts.push(...artifacts);

    let hasAgentSpans = false;
    if (hasExecutionSpans(adapterResponse.metadata)) {
      const agentSpans = adapterResponse.metadata.execution.spans;
      for (const agentSpan of agentSpans) {
        agentSpan.parent_span_id = repoSpan.span_id;
        repoSpan.children.push(agentSpan);
      }
      hasAgentSpans = agentSpans.length > 0;
    }

    const status: SpanStatus = adapterResponse.success ? 'SUCCESS' : 'FAILED';
    const error = adapterResponse.success ? undefined : adapterResponse.error;
    closeSpan(repoSpan, status, error);

    this.activeRepoSpans.delete(repoSpanId);
    this.coreSpan.children.push(repoSpan);

    return hasAgentSpans;
  }

  /**
   * Closes a repo span that failed with an exception.
   */
  closeRepoSpanWithError(repoSpanId: string, error: Error): void {
    const repoSpan = this.activeRepoSpans.get(repoSpanId);
    if (!repoSpan) return; // already closed
    closeSpan(repoSpan, 'FAILED', error.message);
    this.activeRepoSpans.delete(repoSpanId);
    this.coreSpan.children.push(repoSpan);
  }

  // ============================================================================
  // Artifact Attachment
  // ============================================================================

  addCoreArtifact(artifact: SpanArtifact): void {
    this.coreSpan.artifacts.push(artifact);
  }

  // ============================================================================
  // Validation and Finalization
  // ============================================================================

  /**
   * Validates hierarchy per failure semantics:
   * - FAILED if no repo child spans
   * - FAILED if any repo span has zero agent children
   * - PARTIAL if some repo spans failed but all have agent children
   */
  private validateAndComputeStatus(): SpanStatus {
    if (this.coreSpan.children.length === 0) {
      return 'FAILED';
    }

    let anyRepoFailed = false;
    let anyRepoMissingAgents = false;

    for (const repo of this.coreSpan.children) {
      if (repo.children.length === 0) {
        anyRepoMissingAgents = true;
      }
      if (repo.status === 'FAILED') {
        anyRepoFailed = true;
      }
    }

    if (anyRepoMissingAgents) {
      return 'FAILED';
    }

    if (anyRepoFailed) {
      return 'PARTIAL';
    }

    return 'SUCCESS';
  }

  /**
   * Finalizes the execution context and returns the ExecutionGraph.
   * Closes any active (unclosed) repo spans as FAILED.
   */
  finalize(overrideStatus?: SpanStatus): ExecutionGraph {
    for (const [, repoSpan] of this.activeRepoSpans) {
      closeSpan(repoSpan, 'FAILED', 'Span was never closed (early termination)');
      this.coreSpan.children.push(repoSpan);
    }
    this.activeRepoSpans.clear();

    const computedStatus = overrideStatus ?? this.validateAndComputeStatus();
    closeSpan(this.coreSpan, computedStatus);

    return {
      root: this.coreSpan,
      total_spans: countSpans(this.coreSpan),
      status: computedStatus,
    };
  }
}
