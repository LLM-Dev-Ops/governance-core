/**
 * LLM-Governance-Core Lifecycle Subscriber Tests
 *
 * Tests for the lifecycle event subscriber that enforces governance on
 * plan_created, execution_completed, and deployment_started events.
 *
 * Run with:
 *   npx tsc && node --experimental-strip-types tests/lifecycle.test.ts
 */

import { GovernanceCore } from '../dist/lib.js';
import { LifecycleSubscriber } from '../dist/lifecycle/subscriber.js';
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
import type { LifecycleEvent } from '../dist/types.js';

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
        allowed: true,
        reasons: ['Access granted'],
        appliedPolicies: ['policy-1'],
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
        period: { start: new Date(), end: new Date() },
        breakdown: {},
      },
    };
  }

  async getForecast(): Promise<AdapterResponse<CostForecast>> {
    return {
      success: true,
      data: {
        projectedCost: 110.0,
        confidence: 0.85,
        period: { start: new Date(), end: new Date() },
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

class MockSchemaRegistryAdapter {
  async getSchema(): Promise<AdapterResponse<any>> {
    return { success: true, data: {} };
  }

  async validate(): Promise<AdapterResponse<ValidationResult>> {
    return { success: true, data: { valid: true, errors: [] } };
  }

  async registerSchema(): Promise<AdapterResponse<{ schemaId: string; version: string }>> {
    return { success: true, data: { schemaId: 'schema-1', version: 'v1' } };
  }
}

/**
 * Config adapter that returns lifecycle permissions for authorized principals.
 */
class LifecycleMockConfigAdapter {
  async getConfig(key: string): Promise<AdapterResponse<ConfigValue>> {
    if (key === 'rbac.roles.authorized-user') {
      return {
        success: true,
        data: {
          key,
          value: { roles: ['lifecycle-operator'] },
          version: 'v1',
          lastUpdated: new Date(),
        },
      };
    }

    if (key === 'rbac.permissions.lifecycle-operator') {
      return {
        success: true,
        data: {
          key,
          value: {
            permissions: [
              'governance:lifecycle:plan',
              'governance:lifecycle:execution',
              'governance:lifecycle:deployment',
            ],
          },
          version: 'v1',
          lastUpdated: new Date(),
        },
      };
    }

    // Unknown principal / role — return empty
    if (key.startsWith('rbac.roles.')) {
      return { success: false, error: 'Config not found' };
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

// ============================================================================
// Helper
// ============================================================================

function createAdapters(
  configAdapter?: any,
  dashboardAdapter?: MockDashboardAdapter
): { adapters: AdapterCollection; dashboard: MockDashboardAdapter } {
  const dashboard = dashboardAdapter ?? new MockDashboardAdapter();
  const adapters: AdapterCollection = {
    policyEngine: new MockPolicyEngineAdapter(),
    costOps: new MockCostOpsAdapter(),
    analyticsHub: new MockAnalyticsHubAdapter(),
    configManager: configAdapter ?? new LifecycleMockConfigAdapter(),
    schemaRegistry: new MockSchemaRegistryAdapter(),
    dashboard,
  };
  return { adapters, dashboard };
}

// ============================================================================
// Test Cases
// ============================================================================

async function testSubscribedEvents(): Promise<void> {
  console.log('Running: testSubscribedEvents');

  const { adapters } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const events = subscriber.subscribedEvents;

  assert(events.includes('plan_created'), 'Should subscribe to plan_created');
  assert(events.includes('execution_completed'), 'Should subscribe to execution_completed');
  assert(events.includes('deployment_started'), 'Should subscribe to deployment_started');
  assertEqual(events.length, 3, 'Should subscribe to exactly 3 event types');

  console.log('✓ testSubscribedEvents passed');
}

async function testHandlePlanCreated(): Promise<void> {
  console.log('Running: testHandlePlanCreated');

  const { adapters, dashboard } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const event: LifecycleEvent = {
    eventId: 'evt-plan-001',
    type: 'plan_created',
    timestamp: new Date().toISOString(),
    principal: 'authorized-user',
    resourceId: 'plan-resource-1',
    payload: { planName: 'test-plan' },
  };

  const result = await subscriber.handleEvent(event);

  assertEqual(result.eventId, 'evt-plan-001', 'Event ID should match');
  assertEqual(result.accepted, true, 'Event should be accepted');
  assertEqual(result.authorized, true, 'Authorized user should be authorized');
  assertEqual(result.reasons.length, 0, 'No denial reasons for authorized user');
  assert(result.auditId.startsWith('audit-lifecycle-'), 'Audit ID should have lifecycle prefix');

  // Verify governance_recorded was published to dashboard
  // Dashboard receives: audit.signal from emitAuditSignal + governance_recorded from subscriber
  const governanceRecorded = dashboard.publishedEvents.find(
    e => e.eventType === 'governance_recorded'
  );
  assert(governanceRecorded !== undefined, 'governance_recorded event should be published');
  assertEqual(governanceRecorded!.severity, 'info', 'Severity should be info for authorized event');
  assertEqual(
    (governanceRecorded!.details as any).lifecycleEventType,
    'plan_created',
    'Event type in details should be plan_created'
  );

  console.log('✓ testHandlePlanCreated passed');
}

async function testHandleExecutionCompleted(): Promise<void> {
  console.log('Running: testHandleExecutionCompleted');

  const { adapters, dashboard } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const event: LifecycleEvent = {
    eventId: 'evt-exec-001',
    type: 'execution_completed',
    timestamp: new Date().toISOString(),
    principal: 'authorized-user',
    resourceId: 'exec-resource-1',
    payload: { status: 'success' },
  };

  const result = await subscriber.handleEvent(event);

  assertEqual(result.accepted, true, 'Event should be accepted');
  assertEqual(result.authorized, true, 'Authorized user should be authorized');

  const governanceRecorded = dashboard.publishedEvents.find(
    e => e.eventType === 'governance_recorded'
  );
  assert(governanceRecorded !== undefined, 'governance_recorded should be published');
  assertEqual(
    (governanceRecorded!.details as any).lifecycleEventType,
    'execution_completed',
    'Should record execution_completed'
  );

  console.log('✓ testHandleExecutionCompleted passed');
}

async function testHandleDeploymentStarted(): Promise<void> {
  console.log('Running: testHandleDeploymentStarted');

  const { adapters, dashboard } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const event: LifecycleEvent = {
    eventId: 'evt-deploy-001',
    type: 'deployment_started',
    timestamp: new Date().toISOString(),
    principal: 'authorized-user',
    resourceId: 'deploy-resource-1',
    payload: { environment: 'production' },
  };

  const result = await subscriber.handleEvent(event);

  assertEqual(result.accepted, true, 'Event should be accepted');
  assertEqual(result.authorized, true, 'Authorized user should be authorized');

  const governanceRecorded = dashboard.publishedEvents.find(
    e => e.eventType === 'governance_recorded'
  );
  assert(governanceRecorded !== undefined, 'governance_recorded should be published');
  assertEqual(
    (governanceRecorded!.details as any).lifecycleEventType,
    'deployment_started',
    'Should record deployment_started'
  );

  console.log('✓ testHandleDeploymentStarted passed');
}

async function testRBACDenial(): Promise<void> {
  console.log('Running: testRBACDenial');

  const { adapters, dashboard } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const event: LifecycleEvent = {
    eventId: 'evt-denied-001',
    type: 'plan_created',
    timestamp: new Date().toISOString(),
    principal: 'unauthorized-user',
    resourceId: 'plan-resource-1',
    payload: {},
  };

  const result = await subscriber.handleEvent(event);

  assertEqual(result.accepted, true, 'Event should still be accepted (processed)');
  assertEqual(result.authorized, false, 'Unauthorized user should be denied');
  assert(result.reasons.length > 0, 'Should have denial reasons');
  assert(
    result.reasons[0].includes('governance:lifecycle:plan'),
    'Denial reason should mention required permission'
  );

  // Verify audit signal was still recorded (with denied outcome)
  const auditSignal = dashboard.publishedEvents.find(
    e => e.eventType === 'audit.signal'
  );
  assert(auditSignal !== undefined, 'Audit signal should be published even for denied events');

  // Verify governance_recorded was published with warning severity
  const governanceRecorded = dashboard.publishedEvents.find(
    e => e.eventType === 'governance_recorded'
  );
  assert(governanceRecorded !== undefined, 'governance_recorded should be published for denied events');
  assertEqual(
    governanceRecorded!.severity,
    'warning',
    'Severity should be warning for denied event'
  );
  assertEqual(
    (governanceRecorded!.details as any).authorized,
    false,
    'Details should indicate not authorized'
  );

  console.log('✓ testRBACDenial passed');
}

async function testUnsupportedEventType(): Promise<void> {
  console.log('Running: testUnsupportedEventType');

  const { adapters } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const event = {
    eventId: 'evt-bad-001',
    type: 'unknown_event' as any,
    timestamp: new Date().toISOString(),
    principal: 'authorized-user',
    resourceId: 'resource-1',
    payload: {},
  };

  try {
    await subscriber.handleEvent(event);
    throw new Error('Should have thrown for unsupported event type');
  } catch (error) {
    assert(error instanceof Error, 'Should throw Error');
    assert(
      error.message.includes('Unsupported lifecycle event type'),
      'Error should mention unsupported event type'
    );
  }

  console.log('✓ testUnsupportedEventType passed');
}

async function testAuditLogRecorded(): Promise<void> {
  console.log('Running: testAuditLogRecorded');

  const { adapters, dashboard } = createAdapters();
  const core = new GovernanceCore(adapters);
  const subscriber = new LifecycleSubscriber(core, adapters);

  const event: LifecycleEvent = {
    eventId: 'evt-audit-001',
    type: 'execution_completed',
    timestamp: new Date().toISOString(),
    principal: 'authorized-user',
    resourceId: 'exec-resource-1',
    payload: { result: 'success' },
  };

  await subscriber.handleEvent(event);

  // emitAuditSignal publishes an audit.signal event to dashboard
  const auditEvents = dashboard.publishedEvents.filter(
    e => e.eventType === 'audit.signal'
  );
  assert(auditEvents.length > 0, 'At least one audit.signal should be published');

  const auditDetails = auditEvents[0].details as any;
  assertEqual(auditDetails.action, 'lifecycle:execution_completed', 'Audit action should include lifecycle prefix');
  assertEqual(auditDetails.principal, 'authorized-user', 'Audit principal should match');
  assertEqual(auditDetails.resource, 'exec-resource-1', 'Audit resource should match');
  assertEqual(auditDetails.outcome, 'allowed', 'Outcome should be allowed for authorized user');

  console.log('✓ testAuditLogRecorded passed');
}

// ============================================================================
// Test Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting Lifecycle Subscriber Tests\n');

  const tests = [
    testSubscribedEvents,
    testHandlePlanCreated,
    testHandleExecutionCompleted,
    testHandleDeploymentStarted,
    testRBACDenial,
    testUnsupportedEventType,
    testAuditLogRecorded,
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

main().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
