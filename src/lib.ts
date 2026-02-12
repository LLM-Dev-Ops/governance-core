/**
 * LLM-Governance-Core
 *
 * Main orchestration layer - thin glue code that delegates to integrated systems.
 * Instrumented with hierarchical execution spans for the Agentics execution engine.
 */

import { createHash, randomUUID } from 'node:crypto';

import type {
  GovernanceRequest,
  GovernanceDecision,
  PolicyEvaluationResult,
  FinOpsSummary,
  RBACContext,
  AuditSignal,
  CompliancePosture,
  GateClearance,
  GovernanceGateResult,
  ArtifactExportRequest,
  ArtifactExportResult,
  ERPMappingRequest,
  ERPMappingResult,
} from './types';

import type {
  AdapterCollection,
  PolicyEvaluationRequest,
  AnalyticsEvent,
} from './adapters';

import { ExecutionContext } from './execution/context';
import { createArtifact } from './execution/spans';
import type { CoreExecutionResult, ExecutionGraph } from './execution/types';

// ============================================================================
// Execution Options
// ============================================================================

export interface ExecutionOptions {
  parentSpanId?: string;
  includeExecution: true;
}

/** Default clearance validity duration: 15 minutes */
const CLEARANCE_TTL_MS = 15 * 60 * 1000;

/** The three adapter names that MUST appear as repo spans for gate clearance */
const MANDATORY_ADAPTERS = ['policyEngine', 'costOps', 'dashboard'] as const;

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
  // enforceGovernanceGate
  // ============================================================================

  async enforceGovernanceGate(request: GovernanceRequest): Promise<GovernanceGateResult>;
  async enforceGovernanceGate(
    request: GovernanceRequest,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<GovernanceGateResult>>;
  async enforceGovernanceGate(
    request: GovernanceRequest,
    options?: ExecutionOptions
  ): Promise<GovernanceGateResult | CoreExecutionResult<GovernanceGateResult>> {
    const ctx = new ExecutionContext(
      'enforceGovernanceGate',
      options?.parentSpanId ?? null
    );

    const failureReasons: string[] = [];

    try {
      // 1. HARD-invoke Policy Engine
      const policySpanId = ctx.startRepoSpan('policyEngine');
      const policyRequest: PolicyEvaluationRequest = {
        principal: request.principal,
        action: request.action,
        resource: request.resourceId,
        context: request.context || {},
      };

      const policyResponse = await this.adapters.policyEngine.evaluatePolicy(policyRequest);
      ctx.closeRepoSpan(policySpanId, policyResponse, [
        createArtifact('gate-policy-evaluation', 'policy-result',
          { id: request.requestId }, policyResponse.data),
      ]);

      if (!policyResponse.success || !policyResponse.data) {
        throw new Error(`[GATE HARD FAIL] Policy engine: ${policyResponse.error || 'No data returned'}`);
      }

      const policyData = policyResponse.data;

      // 2. HARD-invoke CostOps (no try-catch swallow)
      const costSummary = await this._getFinOpsSummaryWithContext(request.resourceId, ctx);

      // 3. HARD-invoke Dashboard read (getHealthStatus)
      const dashboardSpanId = ctx.startRepoSpan('dashboard');
      const healthResponse = await this.adapters.dashboard.getHealthStatus();
      ctx.closeRepoSpan(dashboardSpanId, healthResponse, [
        createArtifact('gate-dashboard-health', 'health-check',
          { id: `health-${request.requestId}` }, healthResponse.data),
      ]);

      if (!healthResponse.success || !healthResponse.data) {
        throw new Error(`[GATE HARD FAIL] Dashboard health: ${healthResponse.error || 'No data returned'}`);
      }

      const dashboardHealth = healthResponse.data;

      // 4. Assemble Compliance Posture
      const posture: CompliancePosture = {
        status: this._computeComplianceStatus(
          policyData.allowed,
          costSummary.budgetStatus,
          dashboardHealth.healthy
        ),
        policyCompliance: {
          allowed: policyData.allowed,
          appliedPolicies: policyData.appliedPolicies,
          reasons: policyData.reasons,
        },
        costAttribution: {
          resourceId: request.resourceId,
          currentCost: costSummary.currentCost,
          forecastedCost: costSummary.forecast,
          budgetStatus: costSummary.budgetStatus as 'within' | 'warning' | 'exceeded',
          currency: 'USD',
        },
        dashboardHealth: {
          healthy: dashboardHealth.healthy,
          details: dashboardHealth.details,
        },
        evaluatedAt: new Date().toISOString(),
      };

      // 5. Determine gate pass/fail
      if (!policyData.allowed) {
        failureReasons.push('Policy evaluation denied the request');
      }
      if (costSummary.budgetStatus === 'exceeded') {
        failureReasons.push('Budget has been exceeded');
      }
      if (!dashboardHealth.healthy) {
        failureReasons.push('Governance dashboard reports unhealthy state');
      }

      const gatePassed = posture.status !== 'non_compliant';

      // 6. Build governance decision
      const auditId = `audit-gate-${request.requestId}-${Date.now()}`;
      const decision: GovernanceDecision = {
        requestId: request.requestId,
        allowed: policyData.allowed,
        policyResults: {
          allowed: policyData.allowed,
          policies: policyData.appliedPolicies,
          reasons: policyData.reasons,
        },
        costImpact: costSummary,
        auditId,
      };

      // 7. Finalize and issue clearance if gate passed
      const execution = ctx.finalize();

      let clearance: GateClearance | undefined;
      if (gatePassed) {
        const graphHash = this._hashExecutionGraph(execution);
        const now = new Date();
        clearance = {
          clearanceId: randomUUID(),
          requestId: request.requestId,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + CLEARANCE_TTL_MS).toISOString(),
          executionGraphHash: graphHash,
          attestedAdapters: ['policyEngine', 'costOps', 'dashboard'],
          postureSnapshot: posture,
        };
      }

      const gateResult: GovernanceGateResult = {
        passed: gatePassed,
        posture,
        clearance,
        failureReasons: gatePassed ? [] : failureReasons,
        decision,
      };

      if (options?.includeExecution) {
        return { result: gateResult, execution };
      }
      return gateResult;
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      failureReasons.push(errorMsg);

      const failedResult: GovernanceGateResult = {
        passed: false,
        posture: this._buildFailedPosture(request.resourceId),
        failureReasons,
        decision: {
          requestId: request.requestId,
          allowed: false,
          policyResults: { allowed: false, policies: [], reasons: [errorMsg] },
          auditId: `audit-gate-${request.requestId}-${Date.now()}`,
        },
      };

      if (options?.includeExecution) {
        return { result: failedResult, execution };
      }
      throw new Error(`Governance gate failed: ${errorMsg}`);
    }
  }

  // ============================================================================
  // exportArtifacts (gated)
  // ============================================================================

  async exportArtifacts(
    request: ArtifactExportRequest,
    clearance: GateClearance
  ): Promise<ArtifactExportResult>;
  async exportArtifacts(
    request: ArtifactExportRequest,
    clearance: GateClearance,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<ArtifactExportResult>>;
  async exportArtifacts(
    request: ArtifactExportRequest,
    clearance: GateClearance,
    options?: ExecutionOptions
  ): Promise<ArtifactExportResult | CoreExecutionResult<ArtifactExportResult>> {
    const ctx = new ExecutionContext(
      'exportArtifacts',
      options?.parentSpanId ?? null
    );

    try {
      this._validateClearance(clearance);

      // Track export in analytics
      const analyticsSpanId = ctx.startRepoSpan('analyticsHub');
      const analyticsResponse = await this.adapters.analyticsHub.track({
        eventName: 'governance.artifact.export',
        timestamp: new Date(),
        properties: {
          exportId: request.exportId,
          artifactIds: request.artifactIds,
          destination: request.destination,
          clearanceId: clearance.clearanceId,
        },
      });
      ctx.closeRepoSpan(analyticsSpanId, analyticsResponse);

      // Publish export event to dashboard
      const dashboardSpanId = ctx.startRepoSpan('dashboard');
      const dashboardResponse = await this.adapters.dashboard.publishEvent({
        eventType: 'artifact.export',
        severity: 'info',
        timestamp: new Date(),
        details: {
          exportId: request.exportId,
          artifactCount: request.artifactIds.length,
          destination: request.destination,
          clearanceId: clearance.clearanceId,
        },
      });
      ctx.closeRepoSpan(dashboardSpanId, dashboardResponse, [
        createArtifact('export-event', 'dashboard-event', { id: request.exportId }),
      ]);

      const result: ArtifactExportResult = {
        exportId: request.exportId,
        success: true,
        exportedUris: request.artifactIds.map(id => `${request.destination}/${id}`),
        authorizedBy: clearance.clearanceId,
      };

      const execution = ctx.finalize();
      if (options?.includeExecution) {
        return { result, execution };
      }
      return result;
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(
        `Artifact export blocked: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ============================================================================
  // mapToERP (gated)
  // ============================================================================

  async mapToERP(
    request: ERPMappingRequest,
    clearance: GateClearance
  ): Promise<ERPMappingResult>;
  async mapToERP(
    request: ERPMappingRequest,
    clearance: GateClearance,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<ERPMappingResult>>;
  async mapToERP(
    request: ERPMappingRequest,
    clearance: GateClearance,
    options?: ExecutionOptions
  ): Promise<ERPMappingResult | CoreExecutionResult<ERPMappingResult>> {
    const ctx = new ExecutionContext(
      'mapToERP',
      options?.parentSpanId ?? null
    );

    try {
      this._validateClearance(clearance);

      // Report ERP mapping usage to CostOps
      const costSpanId = ctx.startRepoSpan('costOps');
      const usageResponse = await this.adapters.costOps.reportUsage({
        service: request.erpSystem,
        tokens: 0,
        requestId: request.mappingId,
        timestamp: new Date(),
        metadata: {
          resourceIds: request.resourceIds,
          costCenter: request.costCenter,
          clearanceId: clearance.clearanceId,
        },
      });
      ctx.closeRepoSpan(costSpanId, usageResponse, [
        createArtifact('erp-cost-report', 'usage-report', { id: request.mappingId }),
      ]);

      // Publish ERP mapping event to dashboard
      const dashboardSpanId = ctx.startRepoSpan('dashboard');
      const dashboardResponse = await this.adapters.dashboard.publishEvent({
        eventType: 'erp.mapping',
        severity: 'info',
        timestamp: new Date(),
        details: {
          mappingId: request.mappingId,
          erpSystem: request.erpSystem,
          resourceCount: request.resourceIds.length,
          clearanceId: clearance.clearanceId,
        },
      });
      ctx.closeRepoSpan(dashboardSpanId, dashboardResponse, [
        createArtifact('erp-mapping-event', 'dashboard-event', { id: request.mappingId }),
      ]);

      const result: ERPMappingResult = {
        mappingId: request.mappingId,
        success: true,
        erpReferences: request.resourceIds.map(id => `${request.erpSystem}:${id}`),
        authorizedBy: clearance.clearanceId,
      };

      const execution = ctx.finalize();
      if (options?.includeExecution) {
        return { result, execution };
      }
      return result;
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(
        `ERP mapping blocked: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Validates a GateClearance token.
   * Throws if the clearance is invalid, expired, or missing mandatory adapter attestations.
   */
  private _validateClearance(clearance: GateClearance): void {
    if (!clearance || !clearance.clearanceId) {
      throw new Error('Gate clearance is required: no clearance token provided');
    }

    const now = new Date();
    const expiresAt = new Date(clearance.expiresAt);
    if (now > expiresAt) {
      throw new Error(
        `Gate clearance expired: clearance ${clearance.clearanceId} expired at ${clearance.expiresAt}`
      );
    }

    for (const adapter of MANDATORY_ADAPTERS) {
      if (!clearance.attestedAdapters.includes(adapter)) {
        throw new Error(
          `Gate clearance invalid: missing attestation for mandatory adapter "${adapter}"`
        );
      }
    }

    if (!clearance.executionGraphHash || clearance.executionGraphHash.length === 0) {
      throw new Error('Gate clearance invalid: missing execution graph hash');
    }

    if (!clearance.postureSnapshot) {
      throw new Error('Gate clearance invalid: missing posture snapshot');
    }
  }

  /**
   * Computes a SHA-256 hash of the serialized ExecutionGraph.
   */
  private _hashExecutionGraph(graph: ExecutionGraph): string {
    const serialized = JSON.stringify(graph);
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Determines the overall compliance status from the three gate signals.
   */
  private _computeComplianceStatus(
    policyAllowed: boolean,
    budgetStatus: string,
    dashboardHealthy: boolean
  ): 'compliant' | 'non_compliant' | 'degraded' {
    if (!policyAllowed || budgetStatus === 'exceeded') {
      return 'non_compliant';
    }
    if (budgetStatus === 'warning' || !dashboardHealthy) {
      return 'degraded';
    }
    return 'compliant';
  }

  /**
   * Builds a minimal failed posture for error paths.
   */
  private _buildFailedPosture(resourceId: string): CompliancePosture {
    return {
      status: 'non_compliant',
      policyCompliance: {
        allowed: false,
        appliedPolicies: [],
        reasons: ['Gate evaluation failed before policy could be assessed'],
      },
      costAttribution: {
        resourceId,
        currentCost: 0,
        forecastedCost: 0,
        budgetStatus: 'exceeded',
        currency: 'USD',
      },
      dashboardHealth: {
        healthy: false,
        details: {},
      },
      evaluatedAt: new Date().toISOString(),
    };
  }

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
