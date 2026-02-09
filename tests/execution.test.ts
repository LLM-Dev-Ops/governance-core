/**
 * Agentics Execution Engine - Span Instrumentation Tests
 *
 * Verifies hierarchical execution span creation, validation, and output contracts.
 *
 * Run with:
 *   npx tsc && node --experimental-strip-types tests/execution.test.ts
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
import type { GovernanceRequest } from '../dist/types.js';
import type {
  CoreExecutionResult,
  CoreExecutionSpan,
  RepoExecutionSpan,
  AgentExecutionSpan,
} from '../dist/execution/types.js';
import { createArtifact } from '../dist/execution/spans.js';

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
// UUID Validation
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isValidISO8601(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime()) && value.includes('T');
}

// ============================================================================
// Mock Adapters (same as governance.test.ts)
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
          data: { key, value: { roles: ['admin', 'developer'] }, version: 'v1', lastUpdated: new Date() },
        };
      }
    }
    if (key.startsWith('rbac.permissions.')) {
      const role = key.replace('rbac.permissions.', '');
      const permissions: Record<string, string[]> = { admin: ['read', 'write', 'delete'], developer: ['read', 'write'] };
      return {
        success: true,
        data: { key, value: { permissions: permissions[role] || [] }, version: 'v1', lastUpdated: new Date() },
      };
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
    return { success: true, data: { healthy: true, details: {} } };
  }
}

// ============================================================================
// Instrumented Mock Adapter (returns agent spans)
// ============================================================================

class InstrumentedPolicyEngineAdapter extends MockPolicyEngineAdapter {
  async evaluatePolicy(request: PolicyEvaluationRequest): Promise<AdapterResponse<PolicyEvaluationResult>> {
    const baseResult = await super.evaluatePolicy(request);
    return {
      ...baseResult,
      metadata: {
        execution: {
          spans: [
            {
              span_id: 'agent-span-001',
              parent_span_id: null,
              type: 'agent' as const,
              name: 'policy-evaluation-agent',
              status: 'SUCCESS' as const,
              start_time: new Date().toISOString(),
              end_time: new Date().toISOString(),
              artifacts: [],
            },
          ],
        },
      },
    };
  }
}

// ============================================================================
// Helper to create adapters
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
    requestId: 'req-test-001',
    resourceId: 'resource-abc',
    action: 'read',
    principal: 'user-123',
    context: { source: 'test' },
  };
}

// ============================================================================
// Test Cases
// ============================================================================

async function testCoreSpanCreatedOnEvaluate(): Promise<void> {
  console.log('Running: testCoreSpanCreatedOnEvaluate');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  const root = result.execution.root;

  assertEqual(root.type, 'core', 'Root span should be type "core"');
  assertEqual(root.name, 'evaluateGovernance', 'Root span name should be "evaluateGovernance"');
  assert(isValidUUID(root.span_id), `Root span_id should be a valid UUID, got: ${root.span_id}`);
  assert(root.parent_span_id === null, 'Root parent_span_id should be null when no parent provided');
  assert(isValidISO8601(root.start_time), 'Root start_time should be valid ISO-8601');
  assert(root.end_time !== undefined, 'Root end_time should be set after finalize');
  assert(isValidISO8601(root.end_time!), 'Root end_time should be valid ISO-8601');

  console.log('  testCoreSpanCreatedOnEvaluate passed');
}

async function testRepoSpansCreatedForEachAdapter(): Promise<void> {
  console.log('Running: testRepoSpansCreatedForEachAdapter');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  const root = result.execution.root;
  const repoSpans = root.children;

  // evaluateGovernance calls: policyEngine, costOps (x2), analyticsHub, schemaRegistry, dashboard
  assert(repoSpans.length >= 6, `Should have at least 6 repo spans, got ${repoSpans.length}`);

  // Verify all repo spans have correct type and parent
  for (const repo of repoSpans) {
    assertEqual(repo.type, 'repo', `Repo span type should be "repo", got "${repo.type}"`);
    assert(isValidUUID(repo.span_id), `Repo span_id should be valid UUID: ${repo.span_id}`);
    assertEqual(repo.parent_span_id, root.span_id, 'Repo parent_span_id should be core span_id');
    assert(repo.repo_name !== undefined, 'Repo span should have repo_name');
    assert(repo.end_time !== undefined, 'Repo span should have end_time');
  }

  // Verify specific adapter names are present
  const repoNames = repoSpans.map((r: RepoExecutionSpan) => r.repo_name);
  assert(repoNames.includes('policyEngine'), 'Should have policyEngine repo span');
  assert(repoNames.includes('analyticsHub'), 'Should have analyticsHub repo span');
  assert(repoNames.includes('schemaRegistry'), 'Should have schemaRegistry repo span');
  assert(repoNames.includes('dashboard'), 'Should have dashboard repo span');
  assert(repoNames.filter((n: string) => n === 'costOps').length >= 2, 'Should have at least 2 costOps repo spans');

  console.log('  testRepoSpansCreatedForEachAdapter passed');
}

async function testLegacyAdaptersProduceFAILEDStatus(): Promise<void> {
  console.log('Running: testLegacyAdaptersProduceFAILEDStatus');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  // All mock adapters are legacy (no execution spans in metadata)
  // Per requirement 6c: Core MUST FAIL if any repo span lacks agent-level child spans
  assertEqual(result.execution.status, 'FAILED', 'Status should be FAILED when legacy adapters have no agent spans');

  // Domain result should still be present
  assert(result.result !== undefined, 'Domain result should still be returned on FAILED status');
  assertEqual(result.result!.requestId, 'req-test-001', 'Domain result requestId should match');

  // All repo spans should have empty children
  for (const repo of result.execution.root.children) {
    assertEqual(repo.children.length, 0, `Repo span "${repo.repo_name}" should have 0 agent children`);
  }

  console.log('  testLegacyAdaptersProduceFAILEDStatus passed');
}

async function testInstrumentedAdapterProducesAgentSpans(): Promise<void> {
  console.log('Running: testInstrumentedAdapterProducesAgentSpans');

  const adapters = createMockAdapters({
    policyEngine: new InstrumentedPolicyEngineAdapter(),
  });
  const core = new GovernanceCore(adapters);
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  // Find the policyEngine repo span
  const policyRepoSpan = result.execution.root.children.find(
    (r: RepoExecutionSpan) => r.repo_name === 'policyEngine'
  );
  assert(policyRepoSpan !== undefined, 'Should have policyEngine repo span');
  assertEqual(policyRepoSpan!.children.length, 1, 'policyEngine repo span should have 1 agent child');

  const agentSpan = policyRepoSpan!.children[0];
  assertEqual(agentSpan.type, 'agent', 'Child should be type "agent"');
  assertEqual(agentSpan.name, 'policy-evaluation-agent', 'Agent span name should match');
  // Agent span should be re-parented to repo span
  assertEqual(agentSpan.parent_span_id, policyRepoSpan!.span_id, 'Agent parent_span_id should be re-parented to repo span');

  // Overall status is still FAILED because other adapters are legacy
  assertEqual(result.execution.status, 'FAILED', 'Status should still be FAILED (other adapters have no agent spans)');

  console.log('  testInstrumentedAdapterProducesAgentSpans passed');
}

async function testTotalFailureReturnsGraph(): Promise<void> {
  console.log('Running: testTotalFailureReturnsGraph');

  class FailingPolicyEngineAdapter extends MockPolicyEngineAdapter {
    async evaluatePolicy(): Promise<AdapterResponse<PolicyEvaluationResult>> {
      return { success: false, error: 'Policy engine unreachable' };
    }
  }

  const adapters = createMockAdapters({
    policyEngine: new FailingPolicyEngineAdapter(),
  });
  const core = new GovernanceCore(adapters);

  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  // Should have execution graph even on total failure
  assert(result.execution !== undefined, 'Execution graph should be present on failure');
  assertEqual(result.execution.status, 'FAILED', 'Status should be FAILED');
  assertEqual(result.result, undefined, 'Domain result should be undefined on failure');

  // Should have at least the policyEngine repo span
  assert(result.execution.root.children.length >= 1, 'Should have at least 1 repo span');

  const policySpan = result.execution.root.children.find(
    (r: RepoExecutionSpan) => r.repo_name === 'policyEngine'
  );
  assert(policySpan !== undefined, 'Should have policyEngine repo span');
  assertEqual(policySpan!.status, 'FAILED', 'policyEngine repo span should be FAILED');

  console.log('  testTotalFailureReturnsGraph passed');
}

async function testArtifactsAttachedToRepoSpans(): Promise<void> {
  console.log('Running: testArtifactsAttachedToRepoSpans');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  // Find policyEngine repo span - should have policy-evaluation artifact
  const policySpan = result.execution.root.children.find(
    (r: RepoExecutionSpan) => r.repo_name === 'policyEngine'
  );
  assert(policySpan !== undefined, 'Should have policyEngine repo span');
  assert(policySpan!.artifacts.length > 0, 'policyEngine span should have artifacts');

  const policyArtifact = policySpan!.artifacts.find(a => a.name === 'policy-evaluation');
  assert(policyArtifact !== undefined, 'Should have policy-evaluation artifact');
  assert(policyArtifact!.evidence.id !== undefined, 'Artifact should have evidence id');
  assertEqual(policyArtifact!.evidence.id, 'req-test-001', 'Evidence id should be the requestId');

  // Find schemaRegistry repo span - should have schema-validation artifact
  const schemaSpan = result.execution.root.children.find(
    (r: RepoExecutionSpan) => r.repo_name === 'schemaRegistry'
  );
  assert(schemaSpan !== undefined, 'Should have schemaRegistry repo span');
  const schemaArtifact = schemaSpan!.artifacts.find(a => a.name === 'schema-validation');
  assert(schemaArtifact !== undefined, 'Should have schema-validation artifact');
  assertEqual(schemaArtifact!.evidence.id, 'audit.signal.v1', 'Schema evidence id should be schema name');

  console.log('  testArtifactsAttachedToRepoSpans passed');
}

async function testParentSpanIdThreading(): Promise<void> {
  console.log('Running: testParentSpanIdThreading');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { parentSpanId: 'external-caller-span-123', includeExecution: true }
  ) as CoreExecutionResult<any>;

  assertEqual(
    result.execution.root.parent_span_id,
    'external-caller-span-123',
    'Core span parent_span_id should match the caller-provided span id'
  );

  // Verify repo spans point to core
  for (const repo of result.execution.root.children) {
    assertEqual(repo.parent_span_id, result.execution.root.span_id,
      'Repo parent_span_id should be core span_id');
  }

  console.log('  testParentSpanIdThreading passed');
}

async function testBackwardCompatibility(): Promise<void> {
  console.log('Running: testBackwardCompatibility');

  const core = new GovernanceCore(createMockAdapters());

  // Call without options - should return GovernanceDecision directly
  const decision = await core.evaluateGovernance(createTestRequest());

  // Should be a GovernanceDecision, not a CoreExecutionResult
  assert(decision !== undefined, 'Decision should be defined');
  assertEqual(decision.requestId, 'req-test-001', 'Request ID should match');
  assertEqual(decision.allowed, true, 'Action should be allowed');
  assert(decision.policyResults !== undefined, 'Policy results should be defined');

  // Verify it does NOT have execution property (it's not a CoreExecutionResult)
  assert(!('execution' in decision), 'Decision should NOT have execution property when called without options');

  console.log('  testBackwardCompatibility passed');
}

async function testSpanCountAccuracy(): Promise<void> {
  console.log('Running: testSpanCountAccuracy');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  const root = result.execution.root;
  const expectedCount = 1 + root.children.length; // core + all repos (no agent spans from legacy adapters)

  assertEqual(result.execution.total_spans, expectedCount,
    `total_spans should be ${expectedCount} (1 core + ${root.children.length} repos)`);

  console.log('  testSpanCountAccuracy passed');
}

async function testEvidenceReferenceValidation(): Promise<void> {
  console.log('Running: testEvidenceReferenceValidation');

  // Valid artifact with id
  const validArtifact = createArtifact('test', 'test-type', { id: 'test-id' });
  assert(validArtifact.evidence.id === 'test-id', 'Should create artifact with id');

  // Valid artifact with hash
  const hashArtifact = createArtifact('test', 'test-type', { hash: 'sha256:abc123' });
  assert(hashArtifact.evidence.hash === 'sha256:abc123', 'Should create artifact with hash');

  // Valid artifact with uri
  const uriArtifact = createArtifact('test', 'test-type', { uri: 'gs://bucket/path' });
  assert(uriArtifact.evidence.uri === 'gs://bucket/path', 'Should create artifact with uri');

  // Invalid artifact with empty evidence should throw
  try {
    createArtifact('test', 'test-type', {});
    throw new Error('Should have thrown for empty evidence');
  } catch (error) {
    assert(error instanceof Error, 'Should throw Error');
    assert(error.message.includes('evidence reference'), 'Error should mention evidence reference');
  }

  console.log('  testEvidenceReferenceValidation passed');
}

async function testResolveRBACSpans(): Promise<void> {
  console.log('Running: testResolveRBACSpans');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.resolveRBAC(
    'user-123',
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  assertEqual(result.execution.root.type, 'core', 'Root should be core span');
  assertEqual(result.execution.root.name, 'resolveRBAC', 'Root name should be resolveRBAC');

  // Should have configManager repo spans (1 for roles + 2 for permissions)
  const configSpans = result.execution.root.children.filter(
    (r: RepoExecutionSpan) => r.repo_name === 'configManager'
  );
  assert(configSpans.length >= 3, `Should have at least 3 configManager repo spans, got ${configSpans.length}`);

  // Domain result should be correct
  assert(result.result !== undefined, 'RBAC context should be returned');
  assertEqual(result.result!.principal, 'user-123', 'Principal should match');
  assert(result.result!.roles.length === 2, 'Should have 2 roles');

  console.log('  testResolveRBACSpans passed');
}

async function testExecutionGraphIsJSON(): Promise<void> {
  console.log('Running: testExecutionGraphIsJSON');

  const core = new GovernanceCore(createMockAdapters());
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  // Verify the execution graph is JSON-serializable without loss
  const serialized = JSON.stringify(result.execution);
  const deserialized = JSON.parse(serialized);

  assertEqual(deserialized.root.type, 'core', 'Deserialized root type should be "core"');
  assertEqual(deserialized.root.name, 'evaluateGovernance', 'Deserialized root name should match');
  assertEqual(deserialized.status, result.execution.status, 'Deserialized status should match');
  assertEqual(deserialized.total_spans, result.execution.total_spans, 'Deserialized total_spans should match');
  assertEqual(deserialized.root.children.length, result.execution.root.children.length, 'Deserialized children count should match');

  console.log('  testExecutionGraphIsJSON passed');
}

async function testHierarchyInvariant(): Promise<void> {
  console.log('Running: testHierarchyInvariant');

  const adapters = createMockAdapters({
    policyEngine: new InstrumentedPolicyEngineAdapter(),
  });
  const core = new GovernanceCore(adapters);
  const result = await core.evaluateGovernance(
    createTestRequest(),
    { includeExecution: true }
  ) as CoreExecutionResult<any>;

  const root = result.execution.root;

  // Verify: Core -> Repo -> Agent hierarchy
  assertEqual(root.type, 'core', 'Level 0 must be core');
  assert(root.children.length > 0, 'Core must have repo children');

  for (const repo of root.children) {
    assertEqual(repo.type, 'repo', 'Level 1 must be repo');
    assertEqual(repo.parent_span_id, root.span_id, 'Repo parent must be core');

    for (const agent of repo.children) {
      assertEqual(agent.type, 'agent', 'Level 2 must be agent');
      assertEqual(agent.parent_span_id, repo.span_id, 'Agent parent must be repo');
    }
  }

  console.log('  testHierarchyInvariant passed');
}

// ============================================================================
// Test Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting Execution Span Instrumentation Tests\n');

  const tests = [
    testCoreSpanCreatedOnEvaluate,
    testRepoSpansCreatedForEachAdapter,
    testLegacyAdaptersProduceFAILEDStatus,
    testInstrumentedAdapterProducesAgentSpans,
    testTotalFailureReturnsGraph,
    testArtifactsAttachedToRepoSpans,
    testParentSpanIdThreading,
    testBackwardCompatibility,
    testSpanCountAccuracy,
    testEvidenceReferenceValidation,
    testResolveRBACSpans,
    testExecutionGraphIsJSON,
    testHierarchyInvariant,
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
  console.log(`Execution Tests: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
