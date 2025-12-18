/**
 * LLM-Governance-Core Tests
 *
 * Simple test suite for core governance orchestration using basic Node.js patterns.
 *
 * Prerequisites:
 *   - Compile TypeScript first: npx tsc
 *
 * Run with:
 *   node --experimental-strip-types tests/governance.test.ts
 *
 * Or after compilation:
 *   npx tsc && node --experimental-strip-types tests/governance.test.ts
 */

import { GovernanceCore } from '../dist/lib.js';
import { handleGovernanceRequest } from '../dist/handlers/index.js';
import type {
  AdapterCollection,
  AdapterResponse,
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
  CostMetrics,
  CostForecast,
  AnalyticsEvent,
  ConfigValue,
  ValidationResult,
  GovernanceEvent,
} from '../dist/adapters/index.js';
import type { GovernanceRequest } from '../dist/types.js';

// ============================================================================
// Assertion Helpers
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    throw new Error(`${message}\nExpected: ${expectedStr}\nActual: ${actualStr}`);
  }
}

// ============================================================================
// Mock Adapters
// ============================================================================

class MockPolicyEngineAdapter {
  async evaluatePolicy(request: PolicyEvaluationRequest): Promise<AdapterResponse<PolicyEvaluationResult>> {
    return {
      success: true,
      data: {
        allowed: request.action === 'read' || request.action === 'write',
        reasons: request.action === 'read' ? ['Read access granted'] : ['Write access granted'],
        appliedPolicies: ['policy-1', 'policy-2'],
      },
    };
  }

  async validatePolicy(): Promise<AdapterResponse<{ valid: boolean; errors: string[] }>> {
    return { success: true, data: { valid: true, errors: [] } };
  }

  async refreshPolicies(): Promise<AdapterResponse<void>> {
    return { success: true };
  }
}

class MockCostOpsAdapter {
  async reportUsage(): Promise<AdapterResponse<void>> {
    return { success: true };
  }

  async getCostMetrics(): Promise<AdapterResponse<CostMetrics>> {
    return {
      success: true,
      data: {
        totalCost: 100.0,
        currency: 'USD',
        period: {
          start: new Date('2025-01-01'),
          end: new Date('2025-01-31'),
        },
        breakdown: {
          'service-1': 60.0,
          'service-2': 40.0,
        },
      },
    };
  }

  async getForecast(): Promise<AdapterResponse<CostForecast>> {
    return {
      success: true,
      data: {
        projectedCost: 110.0,
        confidence: 0.85,
        period: {
          start: new Date('2025-02-01'),
          end: new Date('2025-02-28'),
        },
      },
    };
  }
}

class MockAnalyticsHubAdapter {
  trackCalls: AnalyticsEvent[] = [];

  async track(event: AnalyticsEvent): Promise<AdapterResponse<void>> {
    this.trackCalls.push(event);
    return { success: true };
  }

  async query(): Promise<AdapterResponse<Record<string, unknown>>> {
    return { success: true, data: {} };
  }

  async trackBatch(): Promise<AdapterResponse<void>> {
    return { success: true };
  }
}

class MockConfigManagerAdapter {
  async getConfig(key: string): Promise<AdapterResponse<ConfigValue>> {
    if (key.startsWith('rbac.roles.')) {
      const principal = key.replace('rbac.roles.', '');
      if (principal === 'user-123') {
        return {
          success: true,
          data: {
            key,
            value: { roles: ['admin', 'developer'] },
            version: 'v1',
            lastUpdated: new Date(),
          },
        };
      }
    }

    if (key.startsWith('rbac.permissions.')) {
      const role = key.replace('rbac.permissions.', '');
      const permissions: Record<string, string[]> = {
        admin: ['read', 'write', 'delete'],
        developer: ['read', 'write'],
      };

      return {
        success: true,
        data: {
          key,
          value: { permissions: permissions[role] || [] },
          version: 'v1',
          lastUpdated: new Date(),
        },
      };
    }

    return { success: false, error: 'Config not found' };
  }

  async getSecret(): Promise<AdapterResponse<string>> {
    return { success: true, data: 'secret-value' };
  }

  async watchConfig(): Promise<AdapterResponse<{ watchId: string }>> {
    return { success: true, data: { watchId: 'watch-123' } };
  }

  async unwatchConfig(): Promise<AdapterResponse<void>> {
    return { success: true };
  }
}

class MockSchemaRegistryAdapter {
  async getSchema(): Promise<AdapterResponse<any>> {
    return { success: true, data: {} };
  }

  async validate(): Promise<AdapterResponse<ValidationResult>> {
    return {
      success: true,
      data: {
        valid: true,
        errors: [],
      },
    };
  }

  async registerSchema(): Promise<AdapterResponse<{ schemaId: string; version: string }>> {
    return { success: true, data: { schemaId: 'schema-1', version: 'v1' } };
  }
}

class MockDashboardAdapter {
  publishedEvents: GovernanceEvent[] = [];

  async publishEvent(event: GovernanceEvent): Promise<AdapterResponse<void>> {
    this.publishedEvents.push(event);
    return { success: true };
  }

  async publishMetrics(): Promise<AdapterResponse<void>> {
    return { success: true };
  }

  async getHealthStatus(): Promise<AdapterResponse<{ healthy: boolean; details: Record<string, unknown> }>> {
    return { success: true, data: { healthy: true, details: {} } };
  }
}

// ============================================================================
// Test Cases
// ============================================================================

async function testEvaluateGovernance(): Promise<void> {
  console.log('Running: testEvaluateGovernance');

  const analyticsAdapter = new MockAnalyticsHubAdapter();
  const dashboardAdapter = new MockDashboardAdapter();

  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: analyticsAdapter,
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: dashboardAdapter,
  };

  const core = new GovernanceCore(adapters);

  const request: GovernanceRequest = {
    requestId: 'req-123',
    resourceId: 'resource-abc',
    action: 'read',
    principal: 'user-123',
    context: { source: 'test' },
  };

  const decision = await core.evaluateGovernance(request);

  // Verify decision structure
  assert(decision !== undefined, 'Decision should be defined');
  assertEqual(decision.requestId, 'req-123', 'Request ID should match');
  assertEqual(decision.allowed, true, 'Action should be allowed');

  // Verify policy results
  assert(decision.policyResults !== undefined, 'Policy results should be defined');
  assertEqual(decision.policyResults.allowed, true, 'Policy should allow action');
  assertDeepEqual(decision.policyResults.policies, ['policy-1', 'policy-2'], 'Applied policies should match');
  assertDeepEqual(decision.policyResults.reasons, ['Read access granted'], 'Reasons should match');

  // Verify cost impact
  assert(decision.costImpact !== undefined, 'Cost impact should be defined');
  assertEqual(decision.costImpact!.resourceId, 'resource-abc', 'Resource ID should match');
  assertEqual(decision.costImpact!.currentCost, 100.0, 'Current cost should match');
  assertEqual(decision.costImpact!.forecast, 110.0, 'Forecast should match');
  assertEqual(decision.costImpact!.budgetStatus, 'within', 'Budget status should be within');

  // Verify audit ID format
  assert(decision.auditId.startsWith('audit-req-123-'), 'Audit ID should have correct format');

  // Verify analytics tracking
  assertEqual(analyticsAdapter.trackCalls.length, 1, 'Analytics should be tracked once');
  assertEqual(analyticsAdapter.trackCalls[0].eventName, 'governance.evaluation', 'Event name should match');
  assertEqual(analyticsAdapter.trackCalls[0].userId, 'user-123', 'User ID should match');

  // Verify dashboard event publication
  assertEqual(dashboardAdapter.publishedEvents.length, 1, 'Dashboard event should be published');
  assertEqual(dashboardAdapter.publishedEvents[0].eventType, 'audit.signal', 'Event type should match');
  assertEqual(dashboardAdapter.publishedEvents[0].severity, 'info', 'Severity should be info for allowed action');

  console.log('✓ testEvaluateGovernance passed');
}

async function testResolveRBAC(): Promise<void> {
  console.log('Running: testResolveRBAC');

  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: new MockDashboardAdapter(),
  };

  const core = new GovernanceCore(adapters);

  const rbacContext = await core.resolveRBAC('user-123');

  // Verify RBAC context
  assert(rbacContext !== undefined, 'RBAC context should be defined');
  assertEqual(rbacContext.principal, 'user-123', 'Principal should match');
  assertDeepEqual(rbacContext.roles, ['admin', 'developer'], 'Roles should match');

  // Verify permissions are aggregated and deduplicated
  const expectedPermissions = ['read', 'write', 'delete'];
  assertEqual(rbacContext.permissions.length, 3, 'Should have 3 unique permissions');
  assert(expectedPermissions.every(p => rbacContext.permissions.includes(p)), 'All permissions should be present');

  console.log('✓ testResolveRBAC passed');
}

async function testResolveRBACNoRoles(): Promise<void> {
  console.log('Running: testResolveRBACNoRoles');

  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: new MockDashboardAdapter(),
  };

  const core = new GovernanceCore(adapters);

  const rbacContext = await core.resolveRBAC('unknown-user');

  // Verify empty context for unknown user
  assertEqual(rbacContext.principal, 'unknown-user', 'Principal should match');
  assertDeepEqual(rbacContext.roles, [], 'Roles should be empty');
  assertDeepEqual(rbacContext.permissions, [], 'Permissions should be empty');

  console.log('✓ testResolveRBACNoRoles passed');
}

async function testGetFinOpsSummary(): Promise<void> {
  console.log('Running: testGetFinOpsSummary');

  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: new MockDashboardAdapter(),
  };

  const core = new GovernanceCore(adapters);

  const summary = await core.getFinOpsSummary('resource-xyz');

  // Verify FinOps summary
  assert(summary !== undefined, 'Summary should be defined');
  assertEqual(summary.resourceId, 'resource-xyz', 'Resource ID should match');
  assertEqual(summary.currentCost, 100.0, 'Current cost should match mock data');
  assertEqual(summary.forecast, 110.0, 'Forecast should match mock data');
  assertEqual(summary.budgetStatus, 'within', 'Budget status should be within (110 < 120)');

  console.log('✓ testGetFinOpsSummary passed');
}

async function testGetFinOpsSummaryBudgetWarning(): Promise<void> {
  console.log('Running: testGetFinOpsSummaryBudgetWarning');

  class WarningCostOpsAdapter extends MockCostOpsAdapter {
    async getCostMetrics(): Promise<AdapterResponse<CostMetrics>> {
      return {
        success: true,
        data: {
          totalCost: 100.0,
          currency: 'USD',
          period: { start: new Date(), end: new Date() },
          breakdown: {},
        },
      };
    }

    async getForecast(): Promise<AdapterResponse<CostForecast>> {
      return {
        success: true,
        data: {
          projectedCost: 125.0, // 1.25x current cost - should trigger warning
          confidence: 0.85,
          period: { start: new Date(), end: new Date() },
        },
      };
    }
  }

  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new WarningCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: new MockDashboardAdapter(),
  };

  const core = new GovernanceCore(adapters);
  const summary = await core.getFinOpsSummary('resource-xyz');

  assertEqual(summary.budgetStatus, 'warning', 'Budget status should be warning (125 > 120)');

  console.log('✓ testGetFinOpsSummaryBudgetWarning passed');
}

async function testHandleGovernanceRequestValidation(): Promise<void> {
  console.log('Running: testHandleGovernanceRequestValidation');

  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: new MockDashboardAdapter(),
  };

  const core = new GovernanceCore(adapters);

  // Test valid request
  const validRequest: GovernanceRequest = {
    requestId: 'req-456',
    resourceId: 'resource-def',
    action: 'write',
    principal: 'user-456',
  };

  const decision = await handleGovernanceRequest(validRequest, core);
  assert(decision !== undefined, 'Valid request should return decision');
  assertEqual(decision.allowed, true, 'Write action should be allowed');

  // Test invalid request - missing requestId
  try {
    await handleGovernanceRequest({ resourceId: 'res', action: 'read', principal: 'user' } as any, core);
    throw new Error('Should have thrown validation error');
  } catch (error) {
    assert(error instanceof Error, 'Should throw Error instance');
    assert(error.message.includes('requestId'), 'Error should mention requestId');
  }

  // Test invalid request - empty principal
  try {
    await handleGovernanceRequest({
      requestId: 'req-1',
      resourceId: 'res',
      action: 'read',
      principal: '',
    }, core);
    throw new Error('Should have thrown validation error');
  } catch (error) {
    assert(error instanceof Error, 'Should throw Error instance');
    assert(error.message.includes('principal'), 'Error should mention principal');
  }

  // Test invalid request - invalid context type (array)
  try {
    await handleGovernanceRequest({
      requestId: 'req-1',
      resourceId: 'res',
      action: 'read',
      principal: 'user',
      context: [] as any,
    }, core);
    throw new Error('Should have thrown validation error');
  } catch (error) {
    assert(error instanceof Error, 'Should throw Error instance');
    assert(error.message.includes('context'), 'Error should mention context');
  }

  console.log('✓ testHandleGovernanceRequestValidation passed');
}

async function testPolicyEvaluationFlow(): Promise<void> {
  console.log('Running: testPolicyEvaluationFlow');

  class DenyPolicyEngineAdapter extends MockPolicyEngineAdapter {
    async evaluatePolicy(request: PolicyEvaluationRequest): Promise<AdapterResponse<PolicyEvaluationResult>> {
      return {
        success: true,
        data: {
          allowed: false,
          reasons: ['Delete action denied by security policy'],
          appliedPolicies: ['security-policy-1'],
        },
      };
    }
  }

  const dashboardAdapter = new MockDashboardAdapter();

  const adapters: AdapterCollection = {
    policyEngine: new DenyPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: dashboardAdapter,
  };

  const core = new GovernanceCore(adapters);

  const request: GovernanceRequest = {
    requestId: 'req-789',
    resourceId: 'resource-sensitive',
    action: 'delete',
    principal: 'user-789',
  };

  const decision = await core.evaluateGovernance(request);

  // Verify denial
  assertEqual(decision.allowed, false, 'Action should be denied');
  assertEqual(decision.policyResults.allowed, false, 'Policy should deny action');
  assertDeepEqual(decision.policyResults.reasons, ['Delete action denied by security policy'], 'Deny reason should match');

  // Verify dashboard event has warning severity for denied action
  assertEqual(dashboardAdapter.publishedEvents.length, 1, 'Dashboard event should be published');
  assertEqual(dashboardAdapter.publishedEvents[0].severity, 'warning', 'Severity should be warning for denied action');

  console.log('✓ testPolicyEvaluationFlow passed');
}

// ============================================================================
// Test Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting LLM-Governance-Core Tests\n');

  const tests = [
    testEvaluateGovernance,
    testResolveRBAC,
    testResolveRBACNoRoles,
    testGetFinOpsSummary,
    testGetFinOpsSummaryBudgetWarning,
    testHandleGovernanceRequestValidation,
    testPolicyEvaluationFlow,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`✗ Test failed: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
main().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
