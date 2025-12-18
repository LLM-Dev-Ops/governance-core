/**
 * LLM-Governance-Core Services Layer
 *
 * Thin orchestration layer (~50-80 lines) that composes adapter calls.
 * Services are stateless glue code with NO business logic - they just coordinate adapters.
 */

import type {
  AdapterCollection,
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
  GovernanceEvent,
  CostMetrics,
  AdapterResponse,
} from '../adapters/index.js';

// ============================================================================
// 1. Policy Coordination Service
// ============================================================================

/**
 * Coordinates policy engine evaluation
 * Thin wrapper around policy engine adapter
 */
export class PolicyCoordinationService {
  async evaluateRequest(
    request: PolicyEvaluationRequest,
    adapters: AdapterCollection
  ): Promise<AdapterResponse<PolicyEvaluationResult>> {
    return adapters.policyEngine.evaluatePolicy(request);
  }
}

// ============================================================================
// 2. Audit Aggregation Service
// ============================================================================

/**
 * Records governance decisions with validation and publishing
 * Validates via schema registry, then publishes to dashboard
 */
export class AuditAggregationService {
  async recordDecision(
    decision: GovernanceEvent,
    adapters: AdapterCollection
  ): Promise<AdapterResponse<void>> {
    // Validate decision against schema registry
    const validation = await adapters.schemaRegistry.validate(
      'governance-event',
      decision
    );

    if (!validation.success || !validation.data?.valid) {
      return {
        success: false,
        error: `Schema validation failed: ${validation.data?.errors.map(e => e.message).join(', ')}`,
      };
    }

    // Publish validated decision to dashboard
    return adapters.dashboard.publishEvent(decision);
  }
}

// ============================================================================
// 3. FinOps Orchestration Service
// ============================================================================

/**
 * Governance metrics combining cost and analytics data
 */
export interface GovernanceMetrics {
  costMetrics: CostMetrics;
  analyticsData: Record<string, unknown>;
}

/**
 * Gets governance metrics by combining CostOps and Analytics Hub data
 * Composes multiple adapter calls for unified financial visibility
 */
export class FinOpsOrchestrationService {
  async getGovernanceMetrics(
    resourceId: string,
    adapters: AdapterCollection
  ): Promise<AdapterResponse<GovernanceMetrics>> {
    // Get cost metrics from CostOps
    const costResponse = await adapters.costOps.getCostMetrics({
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
      endDate: new Date(),
      services: [resourceId],
    });

    if (!costResponse.success || !costResponse.data) {
      return {
        success: false,
        error: `Failed to fetch cost metrics: ${costResponse.error}`,
      };
    }

    // Get analytics data from Analytics Hub
    const analyticsResponse = await adapters.analyticsHub.query({
      metric: 'resource-usage',
      dimensions: ['resourceId'],
      filters: { resourceId },
      timeRange: {
        start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        end: new Date(),
      },
    });

    if (!analyticsResponse.success || !analyticsResponse.data) {
      return {
        success: false,
        error: `Failed to fetch analytics: ${analyticsResponse.error}`,
      };
    }

    // Combine both data sources
    return {
      success: true,
      data: {
        costMetrics: costResponse.data,
        analyticsData: analyticsResponse.data,
      },
    };
  }
}

// ============================================================================
// Exports
// ============================================================================
