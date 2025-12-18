/**
 * LLM-Governance-Core
 *
 * Main orchestration layer - thin glue code that delegates to integrated systems.
 * No retry logic, no caching, no complex error handling.
 */

import type {
  GovernanceRequest,
  GovernanceDecision,
  PolicyEvaluationResult,
  FinOpsSummary,
  RBACContext,
  AuditSignal,
} from './types';

import type {
  AdapterCollection,
  PolicyEvaluationRequest,
  AnalyticsEvent,
} from './adapters';

/**
 * Core governance orchestrator
 * Coordinates policy evaluation, cost tracking, analytics, and audit logging
 */
export class GovernanceCore {
  private adapters: AdapterCollection;

  constructor(adapters: AdapterCollection) {
    this.adapters = adapters;
  }

  /**
   * Evaluate governance for an incoming request
   * Orchestrates policy, cost, analytics, and audit tracking
   */
  async evaluateGovernance(request: GovernanceRequest): Promise<GovernanceDecision> {
    try {
      // 1. Delegate policy evaluation to Policy Engine
      const policyRequest: PolicyEvaluationRequest = {
        principal: request.principal,
        action: request.action,
        resource: request.resourceId,
        context: request.context || {},
      };

      const policyResponse = await this.adapters.policyEngine.evaluatePolicy(policyRequest);

      if (!policyResponse.success || !policyResponse.data) {
        throw new Error(policyResponse.error || 'Policy evaluation failed');
      }

      const policyResults: PolicyEvaluationResult = {
        allowed: policyResponse.data.allowed,
        policies: policyResponse.data.appliedPolicies,
        reasons: policyResponse.data.reasons,
      };

      // 2. Correlate cost data via CostOps
      let costImpact: FinOpsSummary | undefined;
      try {
        const finOpsSummary = await this.getFinOpsSummary(request.resourceId);
        costImpact = finOpsSummary;
      } catch (error) {
        // Cost data is supplementary, don't fail the entire request
        console.warn('Failed to retrieve cost data:', error);
      }

      // 3. Aggregate analytics via Analytics Hub
      const analyticsEvent: AnalyticsEvent = {
        eventName: 'governance.evaluation',
        timestamp: new Date(),
        properties: {
          requestId: request.requestId,
          resourceId: request.resourceId,
          action: request.action,
          principal: request.principal,
          allowed: policyResults.allowed,
        },
        userId: request.principal,
      };

      await this.adapters.analyticsHub.track(analyticsEvent);

      // 4. Generate audit ID and emit audit signal
      const auditId = `audit-${request.requestId}-${Date.now()}`;
      const auditSignal: AuditSignal = {
        timestamp: new Date().toISOString(),
        action: request.action,
        principal: request.principal,
        resource: request.resourceId,
        outcome: policyResults.allowed ? 'allowed' : 'denied',
        metadata: {
          requestId: request.requestId,
          policies: policyResults.policies,
          reasons: policyResults.reasons,
        },
      };

      await this.emitAuditSignal(auditSignal);

      // 5. Return normalized governance decision
      return {
        requestId: request.requestId,
        allowed: policyResults.allowed,
        policyResults,
        costImpact,
        auditId,
      };
    } catch (error) {
      throw new Error(`Governance evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Resolve RBAC context for a principal
   * Delegates to Config Manager for role mappings
   */
  async resolveRBAC(principal: string): Promise<RBACContext> {
    try {
      const rolesConfig = await this.adapters.configManager.getConfig(`rbac.roles.${principal}`);

      if (!rolesConfig.success || !rolesConfig.data) {
        // Return empty context if no roles configured
        return {
          principal,
          roles: [],
          permissions: [],
        };
      }

      const roles = (rolesConfig.data.value as { roles?: string[] })?.roles || [];

      // Get permissions for each role
      const permissionSets = await Promise.all(
        roles.map(async (role) => {
          const permConfig = await this.adapters.configManager.getConfig(`rbac.permissions.${role}`);
          return permConfig.success && permConfig.data
            ? ((permConfig.data.value as { permissions?: string[] })?.permissions || [])
            : [];
        })
      );

      const permissions = Array.from(new Set(permissionSets.flat()));

      return {
        principal,
        roles,
        permissions,
      };
    } catch (error) {
      throw new Error(`RBAC resolution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get FinOps summary for a resource
   * Delegates to CostOps for metrics and forecast
   */
  async getFinOpsSummary(resourceId: string): Promise<FinOpsSummary> {
    try {
      const now = new Date();
      const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      const [metricsResponse, forecastResponse] = await Promise.all([
        this.adapters.costOps.getCostMetrics({
          startDate,
          endDate: now,
          services: [resourceId],
        }),
        this.adapters.costOps.getForecast({
          horizon: 30,
          services: [resourceId],
        }),
      ]);

      if (!metricsResponse.success || !metricsResponse.data) {
        throw new Error(metricsResponse.error || 'Failed to get cost metrics');
      }

      if (!forecastResponse.success || !forecastResponse.data) {
        throw new Error(forecastResponse.error || 'Failed to get cost forecast');
      }

      const currentCost = metricsResponse.data.totalCost;
      const forecast = forecastResponse.data.projectedCost;

      // Simple budget status logic
      const budgetStatus = forecast > currentCost * 1.5 ? 'exceeded' :
                          forecast > currentCost * 1.2 ? 'warning' :
                          'within';

      return {
        resourceId,
        currentCost,
        forecast,
        budgetStatus,
      };
    } catch (error) {
      throw new Error(`FinOps summary failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Emit audit signal
   * Validates signal schema and publishes to Dashboard
   */
  async emitAuditSignal(signal: AuditSignal): Promise<void> {
    try {
      // Validate signal schema via Schema Registry
      const validationResponse = await this.adapters.schemaRegistry.validate('audit.signal.v1', signal);

      if (!validationResponse.success || !validationResponse.data?.valid) {
        const errors = validationResponse.data?.errors || [];
        throw new Error(`Audit signal validation failed: ${errors.map(e => e.message).join(', ')}`);
      }

      // Publish to Dashboard adapter
      await this.adapters.dashboard.publishEvent({
        eventType: 'audit.signal',
        severity: signal.outcome === 'denied' ? 'warning' : 'info',
        timestamp: new Date(signal.timestamp),
        details: signal as unknown as Record<string, unknown>,
      });
    } catch (error) {
      throw new Error(`Audit signal emission failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

/**
 * Factory function to create a GovernanceCore instance
 */
export function createGovernanceCore(adapters: AdapterCollection): GovernanceCore {
  return new GovernanceCore(adapters);
}
