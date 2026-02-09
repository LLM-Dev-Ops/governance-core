/**
 * LLM-Governance-Core
 *
 * Main orchestration layer - thin glue code that delegates to integrated systems.
 * Instrumented with hierarchical execution spans for the Agentics execution engine.
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

import { ExecutionContext } from './execution/context';
import { createArtifact } from './execution/spans';
import type { CoreExecutionResult } from './execution/types';

// ============================================================================
// Execution Options
// ============================================================================

export interface ExecutionOptions {
  parentSpanId?: string;
  includeExecution: true;
}

// ============================================================================
// Core Governance Orchestrator
// ============================================================================

/**
 * Core governance orchestrator.
 * Coordinates policy evaluation, cost tracking, analytics, and audit logging.
 * Every public method is instrumented with execution spans.
 */
export class GovernanceCore {
  private adapters: AdapterCollection;

  constructor(adapters: AdapterCollection) {
    this.adapters = adapters;
  }

  // ============================================================================
  // evaluateGovernance
  // ============================================================================

  async evaluateGovernance(request: GovernanceRequest): Promise<GovernanceDecision>;
  async evaluateGovernance(
    request: GovernanceRequest,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<GovernanceDecision>>;
  async evaluateGovernance(
    request: GovernanceRequest,
    options?: ExecutionOptions
  ): Promise<GovernanceDecision | CoreExecutionResult<GovernanceDecision>> {
    const ctx = new ExecutionContext(
      'evaluateGovernance',
      options?.parentSpanId ?? null
    );

    let decision: GovernanceDecision | undefined;

    try {
      // 1. Delegate policy evaluation to Policy Engine
      const policySpanId = ctx.startRepoSpan('policyEngine');
      const policyRequest: PolicyEvaluationRequest = {
        principal: request.principal,
        action: request.action,
        resource: request.resourceId,
        context: request.context || {},
      };

      const policyResponse = await this.adapters.policyEngine.evaluatePolicy(policyRequest);
      ctx.closeRepoSpan(policySpanId, policyResponse, [
        createArtifact('policy-evaluation', 'policy-result', { id: request.requestId }, policyResponse.data),
      ]);

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
        costImpact = await this._getFinOpsSummaryWithContext(request.resourceId, ctx);
      } catch (error) {
        console.warn('Failed to retrieve cost data:', error);
      }

      // 3. Aggregate analytics via Analytics Hub
      const analyticsSpanId = ctx.startRepoSpan('analyticsHub');
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
      const analyticsResponse = await this.adapters.analyticsHub.track(analyticsEvent);
      ctx.closeRepoSpan(analyticsSpanId, analyticsResponse);

      // 4. Validate audit signal via Schema Registry
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

      const schemaSpanId = ctx.startRepoSpan('schemaRegistry');
      const validationResponse = await this.adapters.schemaRegistry.validate('audit.signal.v1', auditSignal);
      ctx.closeRepoSpan(schemaSpanId, validationResponse, [
        createArtifact('schema-validation', 'validation-result', { id: 'audit.signal.v1' }, validationResponse.data),
      ]);

      if (!validationResponse.success || !validationResponse.data?.valid) {
        const errors = validationResponse.data?.errors || [];
        throw new Error(`Audit signal validation failed: ${errors.map(e => e.message).join(', ')}`);
      }

      // 5. Publish to Dashboard
      const dashboardSpanId = ctx.startRepoSpan('dashboard');
      const dashboardResponse = await this.adapters.dashboard.publishEvent({
        eventType: 'audit.signal',
        severity: auditSignal.outcome === 'denied' ? 'warning' : 'info',
        timestamp: new Date(auditSignal.timestamp),
        details: auditSignal as unknown as Record<string, unknown>,
      });
      ctx.closeRepoSpan(dashboardSpanId, dashboardResponse, [
        createArtifact('audit-event', 'dashboard-event', { id: auditId }),
      ]);

      // 6. Return normalized governance decision
      decision = {
        requestId: request.requestId,
        allowed: policyResults.allowed,
        policyResults,
        costImpact,
        auditId,
      };
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(`Governance evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const execution = ctx.finalize();

    if (options?.includeExecution) {
      return { result: decision, execution };
    }
    return decision;
  }

  // ============================================================================
  // resolveRBAC
  // ============================================================================

  async resolveRBAC(principal: string): Promise<RBACContext>;
  async resolveRBAC(
    principal: string,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<RBACContext>>;
  async resolveRBAC(
    principal: string,
    options?: ExecutionOptions
  ): Promise<RBACContext | CoreExecutionResult<RBACContext>> {
    const ctx = new ExecutionContext(
      'resolveRBAC',
      options?.parentSpanId ?? null
    );

    let rbacContext: RBACContext | undefined;

    try {
      // 1. Get roles config
      const rolesSpanId = ctx.startRepoSpan('configManager');
      const rolesConfig = await this.adapters.configManager.getConfig(`rbac.roles.${principal}`);
      ctx.closeRepoSpan(rolesSpanId, rolesConfig, [
        createArtifact('rbac-roles-lookup', 'config-query', { id: `rbac.roles.${principal}` }),
      ]);

      if (!rolesConfig.success || !rolesConfig.data) {
        rbacContext = { principal, roles: [], permissions: [] };
      } else {
        const roles = (rolesConfig.data.value as { roles?: string[] })?.roles || [];

        // 2. Get permissions for each role
        const permissionSets = await Promise.all(
          roles.map(async (role) => {
            const permSpanId = ctx.startRepoSpan('configManager');
            const permConfig = await this.adapters.configManager.getConfig(`rbac.permissions.${role}`);
            ctx.closeRepoSpan(permSpanId, permConfig, [
              createArtifact('rbac-permission-lookup', 'config-query', { id: `rbac.permissions.${role}` }),
            ]);
            return permConfig.success && permConfig.data
              ? ((permConfig.data.value as { permissions?: string[] })?.permissions || [])
              : [];
          })
        );

        const permissions = Array.from(new Set(permissionSets.flat()));

        rbacContext = { principal, roles, permissions };
      }
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(`RBAC resolution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const execution = ctx.finalize();

    if (options?.includeExecution) {
      return { result: rbacContext, execution };
    }
    return rbacContext;
  }

  // ============================================================================
  // getFinOpsSummary
  // ============================================================================

  async getFinOpsSummary(resourceId: string): Promise<FinOpsSummary>;
  async getFinOpsSummary(
    resourceId: string,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<FinOpsSummary>>;
  async getFinOpsSummary(
    resourceId: string,
    options?: ExecutionOptions
  ): Promise<FinOpsSummary | CoreExecutionResult<FinOpsSummary>> {
    const ctx = new ExecutionContext(
      'getFinOpsSummary',
      options?.parentSpanId ?? null
    );

    let summary: FinOpsSummary | undefined;

    try {
      summary = await this._getFinOpsSummaryWithContext(resourceId, ctx);
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(`FinOps summary failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const execution = ctx.finalize();

    if (options?.includeExecution) {
      return { result: summary, execution };
    }
    return summary;
  }

  // ============================================================================
  // emitAuditSignal
  // ============================================================================

  async emitAuditSignal(signal: AuditSignal): Promise<void>;
  async emitAuditSignal(
    signal: AuditSignal,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<void>>;
  async emitAuditSignal(
    signal: AuditSignal,
    options?: ExecutionOptions
  ): Promise<void | CoreExecutionResult<void>> {
    const ctx = new ExecutionContext(
      'emitAuditSignal',
      options?.parentSpanId ?? null
    );

    try {
      // 1. Validate signal schema via Schema Registry
      const schemaSpanId = ctx.startRepoSpan('schemaRegistry');
      const validationResponse = await this.adapters.schemaRegistry.validate('audit.signal.v1', signal);
      ctx.closeRepoSpan(schemaSpanId, validationResponse, [
        createArtifact('schema-validation', 'validation-result', { id: 'audit.signal.v1' }, validationResponse.data),
      ]);

      if (!validationResponse.success || !validationResponse.data?.valid) {
        const errors = validationResponse.data?.errors || [];
        throw new Error(`Audit signal validation failed: ${errors.map(e => e.message).join(', ')}`);
      }

      // 2. Publish to Dashboard adapter
      const dashboardSpanId = ctx.startRepoSpan('dashboard');
      const dashboardResponse = await this.adapters.dashboard.publishEvent({
        eventType: 'audit.signal',
        severity: signal.outcome === 'denied' ? 'warning' : 'info',
        timestamp: new Date(signal.timestamp),
        details: signal as unknown as Record<string, unknown>,
      });
      ctx.closeRepoSpan(dashboardSpanId, dashboardResponse, [
        createArtifact('audit-event', 'dashboard-event', { id: `audit-${signal.action}-${signal.timestamp}` }),
      ]);
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(`Audit signal emission failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const execution = ctx.finalize();

    if (options?.includeExecution) {
      return { result: undefined, execution };
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Shared FinOps logic used by both evaluateGovernance and getFinOpsSummary.
   * Creates repo spans on the provided ExecutionContext.
   */
  private async _getFinOpsSummaryWithContext(
    resourceId: string,
    ctx: ExecutionContext
  ): Promise<FinOpsSummary> {
    const now = new Date();
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const metricsSpanId = ctx.startRepoSpan('costOps');
    const forecastSpanId = ctx.startRepoSpan('costOps');

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

    ctx.closeRepoSpan(metricsSpanId, metricsResponse, [
      createArtifact('cost-metrics', 'cost-data', { id: `cost-${resourceId}` }, metricsResponse.data),
    ]);
    ctx.closeRepoSpan(forecastSpanId, forecastResponse, [
      createArtifact('cost-forecast', 'cost-data', { id: `forecast-${resourceId}` }, forecastResponse.data),
    ]);

    if (!metricsResponse.success || !metricsResponse.data) {
      throw new Error(metricsResponse.error || 'Failed to get cost metrics');
    }

    if (!forecastResponse.success || !forecastResponse.data) {
      throw new Error(forecastResponse.error || 'Failed to get cost forecast');
    }

    const currentCost = metricsResponse.data.totalCost;
    const forecast = forecastResponse.data.projectedCost;

    const budgetStatus = forecast > currentCost * 1.5 ? 'exceeded' :
                        forecast > currentCost * 1.2 ? 'warning' :
                        'within';

    return {
      resourceId,
      currentCost,
      forecast,
      budgetStatus,
    };
  }
}

/**
 * Factory function to create a GovernanceCore instance
 */
export function createGovernanceCore(adapters: AdapterCollection): GovernanceCore {
  return new GovernanceCore(adapters);
}
