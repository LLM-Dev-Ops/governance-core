/**
 * Governance Gate Enforcement Tests
 *
 * Verifies that LLM-Governance-Core enforces a mandatory execution stage
 * for enterprise simulations, gating artifact export and ERP mapping.
 *
 * Run with:
 *   npx tsc && node --experimental-strip-types tests/governance-gate.test.ts
 */

import { GovernanceCore } from '../dist/lib.js';
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
import type {
  GovernanceRequest,
  GovernanceGateResult,
  GateClearance,
  ArtifactExportRequest,
  ERPMappingRequest,
} from '../dist/types.js';
import type { CoreExecutionResult, RepoExecutionSpan } from '../dist/execution/types.js';

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

class DenyPolicyEngineAdapter extends MockPolicyEngineAdapter {
  async evaluatePolicy(): Promise<AdapterResponse<PolicyEvaluationResult>> {
    return {
      success: true,
      data: {
        allowed: false,
        reasons: ['Action denied by security policy'],
        appliedPolicies: ['deny-policy-1'],
      },
    };
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
        period: { start: new Date('2025-01-01'), end: new Date('2025-01-31') },
        breakdown: { 'service-1': 60.0, 'service-2': 40.0 },
      },
    };
  }
  async getForecast(): Promise<AdapterResponse<CostForecast>> {
    return {
      success: true,
      data: {
        projectedCost: 110.0,
        confidence: 0.85,
        period: { start: new Date('2025-02-01'), end: new Date('2025-02-28') },
      },
    };
  }
}

class FailingCostOpsAdapter extends MockCostOpsAdapter {
  async getCostMetrics(): Promise<AdapterResponse<CostMetrics>> {
    return { success: false, error: 'CostOps service unavailable' };
  }
  async getForecast(): Promise<AdapterResponse<CostForecast>> {
    return { success: false, error: 'CostOps service unavailable' };
  }
}

class WarningCostOpsAdapter extends MockCostOpsAdapter {
  async getForecast(): Promise<AdapterResponse<CostForecast>> {
    return {
      success: true,
      data: {
        projectedCost: 125.0, // 1.25x current cost -> warning
        confidence: 0.85,
        period: { start: new Date('2025-02-01'), end: new Date('2025-02-28') },
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
      return { success: true, data: { key, value: { roles: ['admin'] }, version: 'v1', lastUpdated: new Date() } };
    }
    if (key.startsWith('rbac.permissions.')) {
      return { success: true, data: { key, value: { permissions: ['read', 'write'] }, version: 'v1', lastUpdated: new Date() } };
    }
    return { success: false, error: 'Config not found' };
  }
  async getSecret(): Promise<AdapterResponse<string>> { return { success: true, data: 'secret-value' }; }
  async watchConfig(): Promise<AdapterResponse<{ watchId: string }>> { return { success: true, data: { watchId: 'watch-123' } }; }
  async unwatchConfig(): Promise<AdapterResponse<void>> { return { success: true }; }
}

class MockSchemaRegistryAdapter {
  async getSchema(): Promise<AdapterResponse<any>> { return { success: true, data: {} }; }
  async validate(): Promise<AdapterResponse<ValidationResult>> {
    return { success: true, data: { valid: true, errors: [] } };
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
  async publishMetrics(): Promise<AdapterResponse<void>> { return { success: true }; }
  async getHealthStatus(): Promise<AdapterResponse<{ healthy: boolean; details: Record<string, unknown> }>> {
    return { success: true, data: { healthy: true, details: { uptime: '99.9%' } } };
  }
}

class FailingDashboardAdapter extends MockDashboardAdapter {
  async getHealthStatus(): Promise<AdapterResponse<{ healthy: boolean; details: Record<string, unknown> }>> {
    return { success: false, error: 'Dashboard service unreachable' };
  }
}

class UnhealthyDashboardAdapter extends MockDashboardAdapter {
  async getHealthStatus(): Promise<AdapterResponse<{ healthy: boolean; details: Record<string, unknown> }>> {
    return { success: true, data: { healthy: false, details: { reason: 'degraded backend' } } };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function createMockAdapters(overrides?: Partial<AdapterCollection>): AdapterCollection {
  return {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: new MockConfigManagerAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard: new MockDashboardAdapter(),
    ...overrides,
  };
}

function createTestRequest(): GovernanceRequest {
  return {
    requestId: 'req-gate-001',
    resourceId: 'resource-abc',
    action: 'read',
    principal: 'user-123',
    context: { source: 'test' },
  };
}

function createExportRequest(): ArtifactExportRequest {
  return {
    exportId: 'export-001',
    artifactIds: ['artifact-a', 'artifact-b'],
    destination: 'gs://governance-exports',
  };
}

function createERPRequest(): ERPMappingRequest {
  return {
    mappingId: 'map-001',
    erpSystem: 'sap-s4hana',
    resourceIds: ['resource-abc', 'resource-def'],
    costCenter: 'CC-1234',
  };
}

function createExpiredClearance(): GateClearance {
  const past = new Date(Date.now() - 60000); // 1 minute ago
  return {
    clearanceId: 'clr-expired',
    requestId: 'req-gate-001',
    issuedAt: new Date(Date.now() - 120000).toISOString(),
    expiresAt: past.toISOString(),
    executionGraphHash: 'a'.repeat(64),
    attestedAdapters: ['policyEngine', 'costOps', 'dashboard'],
    postureSnapshot: {
      status: 'compliant',
      policyCompliance: { allowed: true, appliedPolicies: [], reasons: [] },
      costAttribution: { resourceId: 'r', currentCost: 0, forecastedCost: 0, budgetStatus: 'within', currency: 'USD' },
      dashboardHealth: { healthy: true, details: {} },
      evaluatedAt: new Date().toISOString(),
    },
  };
}

function createIncompleteAttestationClearance(): GateClearance {
  const future = new Date(Date.now() + 900000);
  return {
    clearanceId: 'clr-incomplete',
    requestId: 'req-gate-001',
    issuedAt: new Date().toISOString(),
    expiresAt: future.toISOString(),
    executionGraphHash: 'b'.repeat(64),
    attestedAdapters: ['policyEngine', 'costOps'], // missing 'dashboard'
    postureSnapshot: {
      status: 'compliant',
      policyCompliance: { allowed: true, appliedPolicies: [], reasons: [] },
      costAttribution: { resourceId: 'r', currentCost: 0, forecastedCost: 0, budgetStatus: 'within', currency: 'USD' },
      dashboardHealth: { healthy: true, details: {} },
      evaluatedAt: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

async function testGatePassesAllAdaptersSuccessful(): Promise<void> {
  console.log('Running: testGatePassesAllAdaptersSuccessful');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.enforceGovernanceGate(createTestRequest());

  assertEqual(result.passed, true, 'Gate should pass when all adapters succeed');
  assert(result.clearance !== undefined, 'Clearance should be defined when gate passes');
  assertEqual(result.posture.status, 'compliant', 'Posture should be compliant');
  assertEqual(result.failureReasons.length, 0, 'Should have no failure reasons');

  // Verify clearance contents
  const clr = result.clearance!;
  assert(clr.clearanceId.length > 0, 'Clearance ID should be non-empty');
  assertEqual(clr.requestId, 'req-gate-001', 'Clearance requestId should match');
  assert(clr.attestedAdapters.includes('policyEngine'), 'Should attest policyEngine');
  assert(clr.attestedAdapters.includes('costOps'), 'Should attest costOps');
  assert(clr.attestedAdapters.includes('dashboard'), 'Should attest dashboard');
  assert(clr.executionGraphHash.length === 64, 'Graph hash should be 64-char hex');

  // Verify posture details
  assertEqual(result.posture.policyCompliance.allowed, true, 'Policy should be allowed');
  assertEqual(result.posture.costAttribution.budgetStatus, 'within', 'Budget should be within');
  assertEqual(result.posture.dashboardHealth.healthy, true, 'Dashboard should be healthy');

  // Verify decision
  assertEqual(result.decision.requestId, 'req-gate-001', 'Decision requestId should match');
  assertEqual(result.decision.allowed, true, 'Decision should be allowed');
  assert(result.decision.costImpact !== undefined, 'Decision should have cost impact');

  console.log('  testGatePassesAllAdaptersSuccessful passed');
}

async function testGateFailsOnPolicyDenied(): Promise<void> {
  console.log('Running: testGateFailsOnPolicyDenied');

  const adapters = createMockAdapters({ policyEngine: new DenyPolicyEngineAdapter() });
  const core = new GovernanceCore(adapters);
  const result = await core.enforceGovernanceGate(createTestRequest());

  assertEqual(result.passed, false, 'Gate should fail when policy denies');
  assertEqual(result.clearance, undefined, 'No clearance should be issued');
  assertEqual(result.posture.status, 'non_compliant', 'Posture should be non_compliant');
  assert(result.failureReasons.length > 0, 'Should have failure reasons');
  assert(
    result.failureReasons.some(r => r.includes('Policy')),
    'Failure reasons should mention policy'
  );

  console.log('  testGateFailsOnPolicyDenied passed');
}

async function testGateFailsHardOnCostOpsFailure(): Promise<void> {
  console.log('Running: testGateFailsHardOnCostOpsFailure');

  const adapters = createMockAdapters({ costOps: new FailingCostOpsAdapter() });
  const core = new GovernanceCore(adapters);

  // Without includeExecution, should throw
  let threwError = false;
  try {
    await core.enforceGovernanceGate(createTestRequest());
  } catch (error) {
    threwError = true;
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('Governance gate failed'), 'Error should mention gate failure');
  }
  assert(threwError, 'Should have thrown error for CostOps failure (hard gate)');

  // With includeExecution, should return FAILED status
  const result = await core.enforceGovernanceGate(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<GovernanceGateResult>;

  assertEqual(result.execution.status, 'FAILED', 'Execution status should be FAILED');
  assert(result.result !== undefined, 'Result should be defined even on failure');
  assertEqual(result.result!.passed, false, 'Gate should not pass');
  assertEqual(result.result!.clearance, undefined, 'No clearance on failure');

  console.log('  testGateFailsHardOnCostOpsFailure passed');
}

async function testGateFailsHardOnDashboardHealthFailure(): Promise<void> {
  console.log('Running: testGateFailsHardOnDashboardHealthFailure');

  const adapters = createMockAdapters({ dashboard: new FailingDashboardAdapter() });
  const core = new GovernanceCore(adapters);

  let threwError = false;
  try {
    await core.enforceGovernanceGate(createTestRequest());
  } catch (error) {
    threwError = true;
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('Dashboard health'), 'Error should mention dashboard health');
  }
  assert(threwError, 'Should have thrown error for dashboard health failure (hard gate)');

  console.log('  testGateFailsHardOnDashboardHealthFailure passed');
}

async function testGateDegradedOnBudgetWarning(): Promise<void> {
  console.log('Running: testGateDegradedOnBudgetWarning');

  const adapters = createMockAdapters({ costOps: new WarningCostOpsAdapter() });
  const core = new GovernanceCore(adapters);
  const result = await core.enforceGovernanceGate(createTestRequest());

  assertEqual(result.passed, true, 'Gate should still pass on degraded status');
  assertEqual(result.posture.status, 'degraded', 'Posture should be degraded');
  assert(result.clearance !== undefined, 'Clearance should still be issued for degraded');
  assertEqual(result.posture.costAttribution.budgetStatus, 'warning', 'Budget status should be warning');

  console.log('  testGateDegradedOnBudgetWarning passed');
}

async function testExportBlockedWithoutClearance(): Promise<void> {
  console.log('Running: testExportBlockedWithoutClearance');

  const core = new GovernanceCore(createMockAdapters());

  let threwError = false;
  try {
    await core.exportArtifacts(createExportRequest(), null as any);
  } catch (error) {
    threwError = true;
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('clearance'), 'Error should mention clearance');
  }
  assert(threwError, 'Should have thrown error without clearance');

  console.log('  testExportBlockedWithoutClearance passed');
}

async function testExportBlockedWithExpiredClearance(): Promise<void> {
  console.log('Running: testExportBlockedWithExpiredClearance');

  const core = new GovernanceCore(createMockAdapters());

  let threwError = false;
  try {
    await core.exportArtifacts(createExportRequest(), createExpiredClearance());
  } catch (error) {
    threwError = true;
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('expired'), 'Error should mention expiry');
  }
  assert(threwError, 'Should have thrown error for expired clearance');

  console.log('  testExportBlockedWithExpiredClearance passed');
}

async function testExportBlockedWithMissingAdapterAttestation(): Promise<void> {
  console.log('Running: testExportBlockedWithMissingAdapterAttestation');

  const core = new GovernanceCore(createMockAdapters());

  let threwError = false;
  try {
    await core.exportArtifacts(createExportRequest(), createIncompleteAttestationClearance());
  } catch (error) {
    threwError = true;
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('dashboard'), 'Error should mention missing dashboard attestation');
  }
  assert(threwError, 'Should have thrown error for missing attestation');

  console.log('  testExportBlockedWithMissingAdapterAttestation passed');
}

async function testExportSucceedsWithValidClearance(): Promise<void> {
  console.log('Running: testExportSucceedsWithValidClearance');

  const core = new GovernanceCore(createMockAdapters());

  // First, get a valid clearance
  const gateResult = await core.enforceGovernanceGate(createTestRequest());
  assert(gateResult.passed, 'Gate should pass');
  assert(gateResult.clearance !== undefined, 'Clearance should be defined');

  // Now export using the clearance
  const exportResult = await core.exportArtifacts(createExportRequest(), gateResult.clearance!);

  assertEqual(exportResult.exportId, 'export-001', 'Export ID should match');
  assertEqual(exportResult.success, true, 'Export should succeed');
  assertEqual(exportResult.authorizedBy, gateResult.clearance!.clearanceId, 'Should reference clearance ID');
  assertEqual(exportResult.exportedUris.length, 2, 'Should have 2 exported URIs');

  console.log('  testExportSucceedsWithValidClearance passed');
}

async function testERPMappingBlockedWithoutClearance(): Promise<void> {
  console.log('Running: testERPMappingBlockedWithoutClearance');

  const core = new GovernanceCore(createMockAdapters());

  let threwError = false;
  try {
    await core.mapToERP(createERPRequest(), null as any);
  } catch (error) {
    threwError = true;
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('clearance'), 'Error should mention clearance');
  }
  assert(threwError, 'Should have thrown error without clearance');

  console.log('  testERPMappingBlockedWithoutClearance passed');
}

async function testERPMappingSucceedsWithValidClearance(): Promise<void> {
  console.log('Running: testERPMappingSucceedsWithValidClearance');

  const core = new GovernanceCore(createMockAdapters());

  const gateResult = await core.enforceGovernanceGate(createTestRequest());
  assert(gateResult.passed, 'Gate should pass');

  const erpResult = await core.mapToERP(createERPRequest(), gateResult.clearance!);

  assertEqual(erpResult.mappingId, 'map-001', 'Mapping ID should match');
  assertEqual(erpResult.success, true, 'Mapping should succeed');
  assertEqual(erpResult.authorizedBy, gateResult.clearance!.clearanceId, 'Should reference clearance ID');
  assertEqual(erpResult.erpReferences.length, 2, 'Should have 2 ERP references');
  assert(erpResult.erpReferences[0].startsWith('sap-s4hana:'), 'ERP reference should include system prefix');

  console.log('  testERPMappingSucceedsWithValidClearance passed');
}

async function testGateSpanHierarchy(): Promise<void> {
  console.log('Running: testGateSpanHierarchy');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.enforceGovernanceGate(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<GovernanceGateResult>;

  const root = result.execution.root;

  assertEqual(root.type, 'core', 'Root span should be type "core"');
  assertEqual(root.name, 'enforceGovernanceGate', 'Root span name should be "enforceGovernanceGate"');

  // Should have repo spans for: policyEngine, costOps (x2 for metrics + forecast), dashboard
  const repoNames = root.children.map((r: RepoExecutionSpan) => r.repo_name);
  assert(repoNames.includes('policyEngine'), 'Should have policyEngine repo span');
  assert(repoNames.includes('dashboard'), 'Should have dashboard repo span');
  assert(
    repoNames.filter((n: string) => n === 'costOps').length >= 2,
    'Should have at least 2 costOps repo spans (metrics + forecast)'
  );

  // Verify all repo spans point to core span
  for (const repo of root.children) {
    assertEqual(repo.type, 'repo', 'Child should be type "repo"');
    assertEqual(repo.parent_span_id, root.span_id, 'Repo parent should be core span');
    assert(repo.end_time !== undefined, 'Repo span should have end_time');
  }

  // Verify total span count
  assert(result.execution.total_spans >= 5, 'Should have at least 5 spans (1 core + 4 repos)');

  console.log('  testGateSpanHierarchy passed');
}

async function testClearanceContainsValidGraphHash(): Promise<void> {
  console.log('Running: testClearanceContainsValidGraphHash');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.enforceGovernanceGate(createTestRequest());

  assert(result.clearance !== undefined, 'Clearance should be defined');
  const hash = result.clearance!.executionGraphHash;

  assertEqual(hash.length, 64, 'SHA-256 hash should be 64 characters');
  assert(/^[0-9a-f]{64}$/.test(hash), 'Hash should be hex string');

  console.log('  testClearanceContainsValidGraphHash passed');
}

async function testGateWithExecutionOptions(): Promise<void> {
  console.log('Running: testGateWithExecutionOptions');

  const core = new GovernanceCore(createMockAdapters());

  // With includeExecution: true
  const resultWithExec = await core.enforceGovernanceGate(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<GovernanceGateResult>;

  assert(resultWithExec.execution !== undefined, 'Execution graph should be present');
  assert(resultWithExec.result !== undefined, 'Domain result should be present');
  assertEqual(resultWithExec.result!.passed, true, 'Gate should pass');

  // With parentSpanId
  const resultWithParent = await core.enforceGovernanceGate(
    createTestRequest(),
    { parentSpanId: 'external-span-456', includeExecution: true }
  ) as CoreExecutionResult<GovernanceGateResult>;

  assertEqual(
    resultWithParent.execution.root.parent_span_id,
    'external-span-456',
    'Core span parent_span_id should match provided parent'
  );

  console.log('  testGateWithExecutionOptions passed');
}

async function testExportWithExecutionOptions(): Promise<void> {
  console.log('Running: testExportWithExecutionOptions');

  const core = new GovernanceCore(createMockAdapters());

  // Get clearance first
  const gateResult = await core.enforceGovernanceGate(createTestRequest());
  assert(gateResult.clearance !== undefined, 'Clearance should be defined');

  // Export with execution options
  const result = await core.exportArtifacts(
    createExportRequest(),
    gateResult.clearance!,
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  assert(result.execution !== undefined, 'Execution graph should be present');
  assertEqual(result.execution.root.name, 'exportArtifacts', 'Root span name should be exportArtifacts');
  assert(result.result !== undefined, 'Domain result should be present');
  assertEqual(result.result.success, true, 'Export should succeed');

  // Verify repo spans for analyticsHub and dashboard
  const repoNames = result.execution.root.children.map((r: RepoExecutionSpan) => r.repo_name);
  assert(repoNames.includes('analyticsHub'), 'Should have analyticsHub repo span');
  assert(repoNames.includes('dashboard'), 'Should have dashboard repo span');

  console.log('  testExportWithExecutionOptions passed');
}

// ============================================================================
// Test Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting Governance Gate Enforcement Tests\n');

  const tests = [
    testGatePassesAllAdaptersSuccessful,
    testGateFailsOnPolicyDenied,
    testGateFailsHardOnCostOpsFailure,
    testGateFailsHardOnDashboardHealthFailure,
    testGateDegradedOnBudgetWarning,
    testExportBlockedWithoutClearance,
    testExportBlockedWithExpiredClearance,
    testExportBlockedWithMissingAdapterAttestation,
    testExportSucceedsWithValidClearance,
    testERPMappingBlockedWithoutClearance,
    testERPMappingSucceedsWithValidClearance,
    testGateSpanHierarchy,
    testClearanceContainsValidGraphHash,
    testGateWithExecutionOptions,
    testExportWithExecutionOptions,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Governance Gate Tests: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
