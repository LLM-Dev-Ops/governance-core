/**
 * HTTP Gate Enforcement Tests (ADR-0001)
 *
 * Drives the real server over real sockets against stub upstreams. These are the
 * regression guards for the fail-closed contract: an unreachable, slow, denying,
 * or malformed policy authority must produce a denial over HTTP.
 *
 * Run with:
 *   npx tsc && node --experimental-strip-types tests/server-gate.test.ts
 */

import * as http from 'http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { startServer } from '../dist/server.js';
import { resolveUpstreamConfig } from '../dist/adapters/factory.js';

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
    throw new Error(`${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`);
  }
}

// ============================================================================
// Stub Upstreams
// ============================================================================

interface Stub {
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  close(): Promise<void>;
}

type StubHandler = (
  path: string,
  body: unknown,
  res: http.ServerResponse
) => void | Promise<void>;

async function startStub(handler: StubHandler): Promise<Stub> {
  const requests: Stub['requests'] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body: unknown = undefined;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      res.setHeader('Content-Type', 'application/json');
      await handler(req.url ?? '', body, res);
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

/** CostOps + dashboard + analytics stub, all healthy. */
function healthySupportHandler(): StubHandler {
  return (path, _body, res) => {
    if (path === '/api/v1/costs/query') {
      json(res, 200, {
        totalCost: 100,
        currency: 'USD',
        period: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-31T00:00:00.000Z' },
        breakdown: {},
      });
      return;
    }
    if (path === '/api/v1/costs/forecast') {
      json(res, 200, {
        projectedCost: 110,
        confidence: 0.9,
        period: { start: '2026-02-01T00:00:00.000Z', end: '2026-02-28T00:00:00.000Z' },
      });
      return;
    }
    if (path === '/health') {
      json(res, 200, { healthy: true, details: { uptime: '99.9%' } });
      return;
    }
    json(res, 200, { ok: true });
  };
}

/** Returns a port number that nothing is listening on. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

// ============================================================================
// Governance Server Harness
// ============================================================================

interface Harness {
  url: string;
  close(): Promise<void>;
}

async function startGovernance(env: Record<string, string>): Promise<Harness> {
  const server = startServer({ ...env, PORT: '0' } as NodeJS.ProcessEnv);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

interface Scenario {
  governance: Harness;
  policy: Stub;
  support: Stub;
  close(): Promise<void>;
}

async function scenario(
  policyHandler: StubHandler,
  overrides: Record<string, string> = {}
): Promise<Scenario> {
  const policy = await startStub(policyHandler);
  const support = await startStub(healthySupportHandler());
  const governance = await startGovernance({
    POLICY_ENGINE_URL: policy.url,
    COSTOPS_URL: support.url,
    GOVERNANCE_DASHBOARD_URL: support.url,
    ANALYTICS_HUB_URL: support.url,
    ...overrides,
  });

  return {
    governance,
    policy,
    support,
    close: async () => {
      await governance.close();
      await policy.close();
      await support.close();
    },
  };
}

const allowHandler: StubHandler = (_path, _body, res) =>
  json(res, 200, { allowed: true, reasons: ['ok'], appliedPolicies: ['p1'] });

function gateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: 'req-http-001',
    resourceId: 'resource-abc',
    action: 'read',
    principal: 'user-123',
    context: { source: 'test' },
    ...overrides,
  };
}

async function post(url: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ============================================================================
// Test Cases
// ============================================================================

/** ADR Verification 1 — the primary regression guard. */
async function testUnreachablePolicyEngineDenies(): Promise<void> {
  console.log('Running: testUnreachablePolicyEngineDenies');

  const port = await closedPort();
  const support = await startStub(healthySupportHandler());
  const governance = await startGovernance({
    POLICY_ENGINE_URL: `http://127.0.0.1:${port}`,
    COSTOPS_URL: support.url,
    GOVERNANCE_DASHBOARD_URL: support.url,
    ANALYTICS_HUB_URL: support.url,
  });

  try {
    const res = await post(governance.url, '/gate', gateBody());

    assertEqual(res.status, 403, 'Unreachable policy engine must deny with 403');
    assertEqual(res.body.allowed, false, 'Body must carry allowed: false');
    assertEqual(res.body.reason, 'upstream_unavailable', 'Reason must be upstream_unavailable');
    assertEqual(res.body.accepted, undefined, 'Must not return accepted: true');
    assertEqual(res.body.clearance, undefined, 'Must not issue a clearance');
    assert(Array.isArray(res.body.failureReasons) && res.body.failureReasons.length > 0, 'Must report failure reasons');
  } finally {
    await governance.close();
    await support.close();
  }

  console.log('  testUnreachablePolicyEngineDenies passed');
}

/** ADR Verification 1 — a 500 from the authority is also a denial. */
async function testPolicyEngineErrorStatusDenies(): Promise<void> {
  console.log('Running: testPolicyEngineErrorStatusDenies');

  const s = await scenario((_p, _b, res) => json(res, 500, { error: 'boom' }));
  try {
    const res = await post(s.governance.url, '/gate', gateBody());
    assertEqual(res.status, 403, 'Non-2xx from policy engine must deny');
    assertEqual(res.body.reason, 'upstream_unavailable', 'Reason must be upstream_unavailable');
    assertEqual(res.body.clearance, undefined, 'Must not issue a clearance');
  } finally {
    await s.close();
  }

  console.log('  testPolicyEngineErrorStatusDenies passed');
}

/** ADR Verification 1 — a body that does not parse into a decision is a denial. */
async function testUnparseablePolicyResponseDenies(): Promise<void> {
  console.log('Running: testUnparseablePolicyResponseDenies');

  const s = await scenario((_p, _b, res) => json(res, 200, { verdict: 'probably fine' }));
  try {
    const res = await post(s.governance.url, '/gate', gateBody());
    assertEqual(res.status, 403, 'Undecodable policy body must deny');
    assertEqual(res.body.reason, 'upstream_unavailable', 'Reason must be upstream_unavailable');
    assertEqual(res.body.clearance, undefined, 'Must not issue a clearance');
  } finally {
    await s.close();
  }

  console.log('  testUnparseablePolicyResponseDenies passed');
}

/** ADR Verification 2. */
async function testPolicyDenialDenies(): Promise<void> {
  console.log('Running: testPolicyDenialDenies');

  const s = await scenario((_p, _b, res) =>
    json(res, 200, { allowed: false, reasons: ['test-deny'], appliedPolicies: ['p1'] })
  );

  try {
    const res = await post(s.governance.url, '/gate', gateBody());

    assertEqual(res.status, 403, 'Policy denial must produce 403');
    assertEqual(res.body.allowed, false, 'Body must carry allowed: false');
    assert(
      res.body.failureReasons.includes('Policy evaluation denied the request'),
      'failureReasons must include the policy denial reason'
    );
    assertEqual(res.body.clearance, undefined, 'Must not issue a clearance');
    assertEqual(res.body.posture.status, 'non_compliant', 'Posture must be non_compliant');
  } finally {
    await s.close();
  }

  console.log('  testPolicyDenialDenies passed');
}

/** ADR Verification 3. */
async function testPolicyAllowIssuesClearance(): Promise<void> {
  console.log('Running: testPolicyAllowIssuesClearance');

  const s = await scenario(allowHandler);
  try {
    const res = await post(s.governance.url, '/gate', gateBody());

    assertEqual(res.status, 200, 'Allowed request must produce 200');
    assertEqual(res.body.allowed, true, 'Body must carry allowed: true');
    assert(res.body.clearance !== undefined, 'A clearance must be issued');
    assert(typeof res.body.clearance.clearanceId === 'string' && res.body.clearance.clearanceId.length > 0,
      'clearanceId must be non-empty');
    assert(new Date(res.body.clearance.expiresAt).getTime() > Date.now(), 'expiresAt must be in the future');
    assertEqual(
      JSON.stringify(res.body.clearance.attestedAdapters),
      JSON.stringify(['policyEngine', 'costOps', 'dashboard']),
      'attestedAdapters must list the three mandatory adapters'
    );
  } finally {
    await s.close();
  }

  console.log('  testPolicyAllowIssuesClearance passed');
}

/** The gate must run enforceGovernanceGate, not a local stub response. */
async function testGateActuallyInvokesUpstreams(): Promise<void> {
  console.log('Running: testGateActuallyInvokesUpstreams');

  const s = await scenario(allowHandler);
  try {
    const res = await post(s.governance.url, '/gate', gateBody());
    assertEqual(res.status, 200, 'Gate should pass');

    assertEqual(s.policy.requests.length, 1, 'Policy engine must be consulted exactly once');
    assertEqual(s.policy.requests[0].path, '/api/evaluate', 'Policy engine must be called on /api/evaluate');
    const sent = s.policy.requests[0].body as Record<string, unknown>;
    assertEqual(sent.principal, 'user-123', 'Policy request must carry the principal');
    assertEqual(sent.action, 'read', 'Policy request must carry the action');
    assertEqual(sent.resource, 'resource-abc', 'Policy request must carry the resource');

    const supportPaths = s.support.requests.map((r) => r.path);
    assert(supportPaths.includes('/api/v1/costs/query'), 'CostOps metrics must be consulted');
    assert(supportPaths.includes('/api/v1/costs/forecast'), 'CostOps forecast must be consulted');
    assert(supportPaths.includes('/health'), 'Dashboard health must be consulted');

    assertEqual(res.body.message, undefined, 'The "requires configured adapters" stub response must be gone');
  } finally {
    await s.close();
  }

  console.log('  testGateActuallyInvokesUpstreams passed');
}

/** ADR Verification 4. */
async function testTimeoutDenies(): Promise<void> {
  console.log('Running: testTimeoutDenies');

  const timeoutMs = 300;
  const timers: NodeJS.Timeout[] = [];
  const s = await scenario(
    (_p, _b, res) => {
      timers.push(setTimeout(() => json(res, 200, { allowed: true, reasons: [], appliedPolicies: [] }), timeoutMs * 4));
    },
    { GOVERNANCE_UPSTREAM_TIMEOUT_MS: String(timeoutMs) }
  );

  try {
    const started = Date.now();
    const res = await post(s.governance.url, '/gate', gateBody());
    const elapsed = Date.now() - started;

    assertEqual(res.status, 403, 'A timed-out policy engine must deny');
    assertEqual(res.body.reason, 'upstream_unavailable', 'Reason must be upstream_unavailable');
    assertEqual(res.body.clearance, undefined, 'Must not issue a clearance');
    assert(elapsed < timeoutMs * 3, `Must deny within the timeout budget, took ${elapsed}ms`);
  } finally {
    for (const t of timers) clearTimeout(t);
    await s.close();
  }

  console.log('  testTimeoutDenies passed');
}

/** ADR Verification 5. */
async function testClearanceIsEnforcedOnExport(): Promise<void> {
  console.log('Running: testClearanceIsEnforcedOnExport');

  const s = await scenario(allowHandler);
  try {
    const exportRequest = {
      exportId: 'export-001',
      artifactIds: ['artifact-a', 'artifact-b'],
      destination: 'gs://governance-exports',
    };

    const noClearance = await post(s.governance.url, '/export', exportRequest);
    assertEqual(noClearance.status, 403, 'Export without a clearance must be 403');
    assertEqual(noClearance.body.reason, 'clearance_missing', 'Reason must be clearance_missing');

    const forged = await post(s.governance.url, '/export', {
      ...exportRequest,
      clearance: {
        clearanceId: 'forged-clearance-id',
        requestId: 'req-http-001',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        executionGraphHash: 'a'.repeat(64),
        attestedAdapters: ['policyEngine', 'costOps', 'dashboard'],
        postureSnapshot: {},
      },
    });
    assertEqual(forged.status, 403, 'Export with a forged clearanceId must be 403');
    assertEqual(forged.body.reason, 'clearance_unknown', 'Reason must be clearance_unknown');

    const expired = await post(s.governance.url, '/export', {
      ...exportRequest,
      clearance: {
        clearanceId: 'expired-clearance-id',
        requestId: 'req-http-001',
        issuedAt: new Date(Date.now() - 1_200_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        executionGraphHash: 'b'.repeat(64),
        attestedAdapters: ['policyEngine', 'costOps', 'dashboard'],
        postureSnapshot: {},
      },
    });
    assertEqual(expired.status, 403, 'Export with an expired clearance must be 403');

    const gate = await post(s.governance.url, '/gate', gateBody());
    assertEqual(gate.status, 200, 'Gate should issue a clearance');

    const granted = await post(s.governance.url, '/export', {
      ...exportRequest,
      clearance: gate.body.clearance,
    });
    assertEqual(granted.status, 200, 'Export with a freshly issued clearance must succeed');
    assertEqual(granted.body.success, true, 'Export result should report success');
    assertEqual(
      granted.body.authorizedBy,
      gate.body.clearance.clearanceId,
      'Export must be attributed to the issued clearance'
    );
  } finally {
    await s.close();
  }

  console.log('  testClearanceIsEnforcedOnExport passed');
}

async function testClearanceIsEnforcedOnErpMap(): Promise<void> {
  console.log('Running: testClearanceIsEnforcedOnErpMap');

  const s = await scenario(allowHandler);
  try {
    const mapRequest = {
      mappingId: 'map-001',
      erpSystem: 'sap-s4hana',
      resourceIds: ['resource-abc'],
      costCenter: 'CC-1234',
    };

    const noClearance = await post(s.governance.url, '/erp-map', mapRequest);
    assertEqual(noClearance.status, 403, 'ERP mapping without a clearance must be 403');
    assertEqual(noClearance.body.reason, 'clearance_missing', 'Reason must be clearance_missing');

    const gate = await post(s.governance.url, '/gate', gateBody());
    const granted = await post(s.governance.url, '/erp-map', { ...mapRequest, clearance: gate.body.clearance });
    assertEqual(granted.status, 200, 'ERP mapping with a valid clearance must succeed');
    assertEqual(granted.body.authorizedBy, gate.body.clearance.clearanceId, 'Mapping must cite the clearance');
  } finally {
    await s.close();
  }

  console.log('  testClearanceIsEnforcedOnErpMap passed');
}

/** ADR Verification 6 — no echoed request masquerading as a decision. */
async function testV1RoutesDoNotEchoEvaluationResult(): Promise<void> {
  console.log('Running: testV1RoutesDoNotEchoEvaluationResult');

  const s = await scenario(allowHandler);
  try {
    const payload = { event: 'plan_created', source: 'test-suite', cost_impact: { usd: 1 } };

    const evaluate = await post(s.governance.url, '/v1/policy/evaluate', payload);
    assertEqual(evaluate.status, 202, '/v1/policy/evaluate remains an async forwarder');
    assert(!('evaluation_result' in evaluate.body), '/v1/policy/evaluate must not return evaluation_result');
    assert(!JSON.stringify(evaluate.body).includes('plan_created'), 'Response must not echo the request payload');

    const record = await post(s.governance.url, '/v1/compliance/record', payload);
    assertEqual(record.status, 202, '/v1/compliance/record remains an async forwarder');
    assert(!('evaluation_result' in record.body), '/v1/compliance/record must not return evaluation_result');
  } finally {
    await s.close();
  }

  console.log('  testV1RoutesDoNotEchoEvaluationResult passed');
}

/** ADR Verification 7. */
async function testBootRefusesOnMisconfiguration(): Promise<void> {
  console.log('Running: testBootRefusesOnMisconfiguration');

  let threw = false;
  try {
    resolveUpstreamConfig({ COSTOPS_URL: 'https://example.invalid' } as NodeJS.ProcessEnv);
  } catch (error) {
    threw = true;
    assert(
      error instanceof Error && error.message.includes('POLICY_ENGINE_URL'),
      'Error must name the missing POLICY_ENGINE_URL'
    );
  }
  assert(threw, 'resolveUpstreamConfig must throw when POLICY_ENGINE_URL is unset');

  const child = spawnSync(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH ?? '',
      COSTOPS_URL: 'https://example.invalid',
      GOVERNANCE_DASHBOARD_URL: 'https://example.invalid',
      ANALYTICS_HUB_URL: 'https://example.invalid',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert(child.status !== 0, `Server must exit non-zero without POLICY_ENGINE_URL, got status ${child.status}`);
  assert(
    (child.stderr ?? '').includes('POLICY_ENGINE_URL'),
    'Startup failure must name the missing variable'
  );

  console.log('  testBootRefusesOnMisconfiguration passed');
}

/** The gate rejects malformed input rather than fabricating a request. */
async function testInvalidGateBodyIsRejected(): Promise<void> {
  console.log('Running: testInvalidGateBodyIsRejected');

  const s = await scenario(allowHandler);
  try {
    const res = await post(s.governance.url, '/gate', { requestId: 'req-1' });
    assertEqual(res.status, 400, 'Missing mandatory fields must be a 400');
    assertEqual(s.policy.requests.length, 0, 'A malformed request must not reach the policy engine');
  } finally {
    await s.close();
  }

  console.log('  testInvalidGateBodyIsRejected passed');
}

// ============================================================================
// Test Runner
// ============================================================================

async function main(): Promise<void> {
  console.log('Starting HTTP Gate Enforcement Tests (ADR-0001)\n');

  const tests = [
    testUnreachablePolicyEngineDenies,
    testPolicyEngineErrorStatusDenies,
    testUnparseablePolicyResponseDenies,
    testPolicyDenialDenies,
    testPolicyAllowIssuesClearance,
    testGateActuallyInvokesUpstreams,
    testTimeoutDenies,
    testClearanceIsEnforcedOnExport,
    testClearanceIsEnforcedOnErpMap,
    testV1RoutesDoNotEchoEvaluationResult,
    testBootRefusesOnMisconfiguration,
    testInvalidGateBodyIsRejected,
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
  console.log(`HTTP Gate Tests: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Test runner error:', error);
  process.exit(1);
});
