#!/usr/bin/env node
/**
 * LLM-Governance-Core CLI
 * Simple command-line interface for testing governance functionality
 */

import type {
  GovernanceRequest,
  RBACContext,
  FinOpsSummary,
  AuditSignal,
  PolicyEvaluationResult,
} from './types';
import type {
  ICostOpsAdapter,
  IGovernanceDashboardAdapter,
  IPolicyEngineAdapter,
  AdapterResponse,
} from './adapters';

// Mock adapters for CLI testing
const mockPolicyAdapter: IPolicyEngineAdapter = {
  async evaluatePolicy(req) {
    return {
      success: true,
      data: {
        allowed: true,
        reasons: ['Default allow policy'],
        appliedPolicies: ['default-policy'],
      },
    };
  },
  async validatePolicy() {
    return { success: true, data: { valid: true, errors: [] } };
  },
  async refreshPolicies() {
    return { success: true };
  },
};

const mockCostAdapter: ICostOpsAdapter = {
  async reportUsage() {
    return { success: true };
  },
  async getCostMetrics() {
    return {
      success: true,
      data: {
        totalCost: 42.5,
        currency: 'USD',
        period: { start: new Date(), end: new Date() },
        breakdown: { compute: 30, storage: 12.5 },
      },
    };
  },
  async getForecast() {
    return {
      success: true,
      data: { projectedCost: 120, confidence: 0.85, period: { start: new Date(), end: new Date() } },
    };
  },
};

const mockDashboardAdapter: IGovernanceDashboardAdapter = {
  async publishEvent() {
    return { success: true };
  },
  async publishMetrics() {
    return { success: true };
  },
  async getHealthStatus() {
    return { success: true, data: { healthy: true, details: { uptime: '99.9%' } } };
  },
};

// CLI command handlers
async function handleEvaluate(requestJson: string): Promise<void> {
  const request: GovernanceRequest = JSON.parse(requestJson);
  const policyResult = await mockPolicyAdapter.evaluatePolicy({
    principal: request.principal,
    action: request.action,
    resource: request.resourceId,
    context: request.context || {},
  });

  console.log(JSON.stringify({ requestId: request.requestId, ...policyResult.data }, null, 2));
}

async function handleRbac(principalId: string): Promise<void> {
  const rbacContext: RBACContext = {
    principal: principalId,
    roles: ['viewer', 'editor'],
    permissions: ['read', 'write', 'llm:invoke'],
    scope: 'org:default',
  };
  console.log(JSON.stringify(rbacContext, null, 2));
}

async function handleFinOps(resourceId: string): Promise<void> {
  const summary: FinOpsSummary = {
    resourceId,
    currentCost: 45.2,
    forecast: 135.6,
    budgetStatus: 'within',
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function handleAudit(signalJson: string): Promise<void> {
  const signal: AuditSignal = JSON.parse(signalJson);
  await mockDashboardAdapter.publishEvent({
    eventType: 'audit',
    severity: 'info',
    timestamp: new Date(signal.timestamp),
    details: signal,
  });
  console.log(JSON.stringify({ emitted: true, signal }, null, 2));
}

async function handleHealth(): Promise<void> {
  const health = await mockDashboardAdapter.getHealthStatus();
  console.log(JSON.stringify(health.data, null, 2));
}

// Main CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'evaluate':
        const requestIdx = args.indexOf('--request');
        if (requestIdx === -1 || !args[requestIdx + 1]) {
          throw new Error('Missing --request <json> argument');
        }
        await handleEvaluate(args[requestIdx + 1]);
        break;

      case 'rbac':
        const principalIdx = args.indexOf('--principal');
        if (principalIdx === -1 || !args[principalIdx + 1]) {
          throw new Error('Missing --principal <id> argument');
        }
        await handleRbac(args[principalIdx + 1]);
        break;

      case 'finops':
        const resourceIdx = args.indexOf('--resource');
        if (resourceIdx === -1 || !args[resourceIdx + 1]) {
          throw new Error('Missing --resource <id> argument');
        }
        await handleFinOps(args[resourceIdx + 1]);
        break;

      case 'audit':
        const signalIdx = args.indexOf('--signal');
        if (signalIdx === -1 || !args[signalIdx + 1]) {
          throw new Error('Missing --signal <json> argument');
        }
        await handleAudit(args[signalIdx + 1]);
        break;

      case 'health':
        await handleHealth();
        break;

      default:
        console.error('Usage: cli <command> [options]');
        console.error('Commands:');
        console.error('  evaluate --request <json>');
        console.error('  rbac --principal <id>');
        console.error('  finops --resource <id>');
        console.error('  audit --signal <json>');
        console.error('  health');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
