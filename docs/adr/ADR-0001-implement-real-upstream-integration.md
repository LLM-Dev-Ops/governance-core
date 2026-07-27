# ADR-0001: Close the Governance Gate Bypass in the HTTP Surface

**Status:** Proposed

**Date:** 2026-07-27

## Context

`llm-governance-core` is documented as "the central coordination point for governance
operations" (`README.md:7`), delegating policy evaluation, cost attribution, and audit to
upstream services. It issues `GateClearance` tokens that downstream operations
(`/export`, `/erp-map`) are supposed to require.

A verification pass over `src/` found that the repository contains **two independent and
divergent implementations of the gate**, and the one that is actually deployed does not
enforce anything.

### Finding 1: the SDK gate is sound; the HTTP server does not use it

`src/lib.ts` implements a genuine fail-closed gate in `enforceGovernanceGate`
(`src/lib.ts:366-530`):

- It hard-invokes the policy engine and throws `[GATE HARD FAIL]` when the adapter returns
  no data (`src/lib.ts:397-399`).
- It hard-invokes CostOps and the dashboard health check, throwing on failure
  (`src/lib.ts:414-416`).
- `_computeComplianceStatus` (`src/lib.ts:739-751`) returns `non_compliant` when
  `!policyAllowed || budgetStatus === 'exceeded'`, and `gatePassed` is derived from it
  (`src/lib.ts:457`), so a policy denial correctly withholds the clearance token
  (`src/lib.ts:476-490`).

This logic is correct. **It is also unreachable from the network.** `src/server.ts` — the
Cloud Run entrypoint (`package.json:9`, `"start": "node dist/server.js"`) — never imports
`lib.ts`, never constructs the SDK, and never calls `enforceGovernanceGate`.

### Finding 2: `POST /gate` unconditionally returns success

```ts
// src/server.ts:176-190
if (req.method === 'POST' && req.url === '/gate') {
    const parsed = await parseBody(req);
    res.writeHead(200);
    res.end(JSON.stringify({
      accepted: true,
      requestId: parsed.requestId || null,
      message: 'Governance gate enforcement requires configured adapters. Use the SDK ...',
    }));
```

Any caller that POSTs syntactically valid JSON receives `200 {"accepted": true}`. No policy
engine is consulted, no clearance is issued or withheld, and no denial is possible. The
`/evaluate` endpoint (`src/server.ts:160-174`) has the identical shape. `/export`
(`src/server.ts:192-206`) and `/erp-map` (`src/server.ts:208-222`) likewise return
`accepted: true` while their own message text states they "require a valid GateClearance" —
which they never parse or validate.

The advertised mandatory gate is, over HTTP, an unconditional pass.

### Finding 3: upstream calls are fire-and-forget, and the "evaluation result" is the echoed request

The newer routing endpoints do make real outbound calls, but discard every response.
`fireAndForget` (`src/server.ts:41-63`) is explicitly documented as "Errors are logged but
never propagated to the caller"; the response is drained with `outRes.resume()`
(`src/server.ts:57`) and the status code is never inspected.

`POST /v1/policy/evaluate` (`src/server.ts:133-154`) is the sharpest case:

```ts
// src/server.ts:139-147
const policyBody = { context: payload, action: payload.event };
fireAndForget(POLICY_ENGINE_URL, '/api/evaluate', policyBody);
routedTo.push('policy-engine');
res.writeHead(202);
res.end(JSON.stringify({ accepted: true, evaluation_result: policyBody, routed_to: routedTo }));
```

`evaluation_result` is `policyBody` — the request that was just sent upstream, echoed back.
It is not a decision. A consumer reading `evaluation_result` to determine whether an action
is permitted receives its own input, and receives it whether or not the policy engine is
reachable, returned 500, or denied the request. `POST /v1/compliance/record`
(`src/server.ts:92-127`) has the same defect.

The upstream URLs and env vars the service already expects are defined at
`src/server.ts:15-17`:

| Env var | Default | Path used |
|---|---|---|
| `COSTOPS_URL` | `https://llm-costops-1062287243982.us-central1.run.app` | `POST /api/v1/events` |
| `POLICY_ENGINE_URL` | `https://policy-engine-1062287243982.us-central1.run.app` | `POST /api/evaluate` |
| `ANALYTICS_HUB_URL` | `https://llm-analytics-hub-1062287243982.us-central1.run.app` | `POST /api/v1/events` |

### Finding 4: the services layer is thin but not hollow; the adapter layer is types-only

`src/services/index.ts` (131 lines) does define `PolicyCoordinationService`,
`AuditAggregationService`, and `FinOpsOrchestrationService`. These are real, but they are
pure delegation over an injected `AdapterCollection` and are not referenced by `server.ts`.

`src/adapters/index.ts` (302 lines) contains **only TypeScript interfaces** —
`ICostOpsAdapter`, `IPolicyEngineAdapter`, `IGovernanceDashboardAdapter`, and the
`AdapterCollection` shape (`src/adapters/index.ts:272-279`). There is no concrete
implementation of any adapter anywhere in `src/`. `AdapterFactoryRegistry`
(`src/adapters/index.ts:289-296`) declares factory slots that nothing fills. The single
`https.request` call in the whole tree is the one inside `fireAndForget`.

So the SDK gate is fail-closed *by construction* but can never run in production, because
no concrete adapter exists to inject into it.

### Finding 5: three of four test files never run

`package.json:10` runs `node --experimental-strip-types tests/governance.test.ts` — a single
file. `tests/governance-gate.test.ts`, `tests/lifecycle.test.ts`, and
`tests/execution.test.ts` are never executed by `npm test`.

## Decision

We will make the deployed HTTP surface the same gate as the SDK, and it will **fail closed**.

1. **Fail-closed is the default and is non-negotiable for the gate.** If the policy engine
   cannot be reached, times out, returns a non-2xx status, or returns a body that does not
   parse into a `PolicyEvaluationResult`, the gate returns **`403` with
   `{"allowed": false}`** and a machine-readable `reason` of `upstream_unavailable`. An
   unreachable authority is a denial, never a pass. There will be no configuration flag,
   env var, or header that converts an upstream failure into an allow.

2. **Implement concrete HTTP adapters** for the interfaces in `src/adapters/index.ts`,
   starting with `IPolicyEngineAdapter` and `ICostOpsAdapter`, using the URLs and env vars
   already established at `src/server.ts:15-17`. Adapters make **awaited, response-checked**
   requests with an explicit timeout, and surface failures as
   `AdapterResponse{success: false, error}` — which `enforceGovernanceGate` already converts
   into a hard fail at `src/lib.ts:397-399`.

3. **`server.ts` delegates to `lib.ts`.** `POST /gate` and `POST /evaluate` construct the
   `AdapterCollection` from the concrete adapters and call `enforceGovernanceGate`. The
   stub responses at `src/server.ts:160-190` are deleted. The HTTP status mirrors the
   decision: `200` only when `passed === true` and a clearance was issued, `403` otherwise,
   with `failureReasons` in the body.

4. **`/export` and `/erp-map` verify the clearance token** by calling the existing
   `_validateClearance` (`src/lib.ts:698`) against the `GateClearance` supplied in the
   request body, returning `403` when it is absent, malformed, expired, or missing the
   mandatory adapter attestations.

5. **Retire `fireAndForget` for anything decision-bearing.** It may remain for genuinely
   advisory telemetry (analytics-hub event emission), but never on a path whose response
   claims to carry an evaluation. The `evaluation_result` field stops echoing the request
   and carries the upstream decision or is absent.

6. **Distinguish the two remaining `202` routes.** `/v1/compliance/record` and
   `/v1/policy/evaluate` are renamed in documentation as asynchronous *record/forward*
   endpoints and must state that they are **not** gates. Any caller using them for
   authorization is misusing them; the response schema drops `evaluation_result` entirely
   so that misuse is not possible.

## Consequences

**Positive.** The mandatory gate becomes actually mandatory. A policy denial produces a
denial over HTTP. Governance decisions become auditable, because the clearance token is
issued only after real upstream attestation. The existing, already-correct `lib.ts` logic
finally executes in production.

**Negative.** The gate acquires a hard runtime dependency on policy-engine availability:
if policy-engine is down, governed operations stop. This is the intended trade-off — a
governance gate that stays open when its authority is unreachable provides no assurance —
but it makes policy-engine's uptime a availability constraint on every governed workflow,
and it needs its own SLO and alerting.

Latency increases: `/gate` moves from an immediate local response to awaiting two or three
upstream round-trips. Timeouts must be tuned below the caller's own budget.

This is a **breaking change for any current consumer**, since every caller that today
receives `200 accepted:true` may begin receiving `403`. Consumers who have (reasonably)
built on the current always-pass behavior will break — which is the point, but it demands a
staged rollout and consumer notification.

Any environment currently relying on simulator-style pass-through for local development
must switch to running an explicit policy-engine stub. "No adapter configured" ceases to be
a runnable production state.

## Implementation Plan

1. Add `src/adapters/http/policy-engine.ts` implementing `IPolicyEngineAdapter` over
   `POLICY_ENGINE_URL` `POST /api/evaluate`, with an awaited request, a configurable
   timeout (default 5000 ms via `GOVERNANCE_UPSTREAM_TIMEOUT_MS`), non-2xx mapped to
   `{success: false}`, and no retry-into-allow path.
2. Add `src/adapters/http/cost-ops.ts` implementing `ICostOpsAdapter` over `COSTOPS_URL`,
   same error discipline.
3. Add `src/adapters/http/dashboard.ts` implementing `IGovernanceDashboardAdapter`
   `getHealthStatus`, since `enforceGovernanceGate` hard-invokes it at `src/lib.ts:411-419`.
4. Add `src/adapters/factory.ts` exporting `createAdapterCollection(env)` that assembles the
   `AdapterCollection` and **throws at startup** if a required upstream URL is unset and no
   explicit override is provided — the process must refuse to boot into a state where the
   gate cannot evaluate.
5. Rewrite `POST /gate` in `src/server.ts` to call `enforceGovernanceGate`, mapping
   `passed` to `200`/`403` and returning `failureReasons` and the `clearance` on success.
6. Rewrite `POST /evaluate` to call `evaluateGovernance`, returning the real
   `PolicyEvaluationResult`.
7. Add clearance verification to `/export` and `/erp-map` via `_validateClearance`.
8. Remove `evaluation_result` from the `/v1/*` response bodies and document them as
   fire-and-forget forwarders.
9. Change `package.json:10` to run the whole suite (`tests/*.test.ts`) so
   `governance-gate.test.ts`, `lifecycle.test.ts`, and `execution.test.ts` execute.
10. Add the upstream-failure tests described under Verification.
11. Add a startup log line recording which upstream URLs are in effect, to make
    misconfiguration visible in Cloud Run logs.

## Verification

The change is complete when all of the following hold.

1. **Unreachable upstream denies.** With `POLICY_ENGINE_URL` pointed at a closed port,
   `POST /gate` with a valid body returns **HTTP 403** and a body containing
   `"allowed": false` and `reason: "upstream_unavailable"`. It must not return `200`, must
   not return `accepted: true`, and must not include a `clearance`. This test is the
   primary regression guard for this ADR.

2. **Policy denial denies.** With a stub policy engine returning
   `{allowed: false, reasons: ["test-deny"], appliedPolicies: ["p1"]}`, `POST /gate`
   returns **HTTP 403**, `failureReasons` includes `"Policy evaluation denied the request"`,
   and `clearance` is `undefined`.

3. **Policy allow passes and issues a token.** With a stub returning `{allowed: true}` and
   healthy cost/dashboard stubs, `POST /gate` returns **HTTP 200** with a `clearance`
   carrying a non-empty `clearanceId`, an `expiresAt` in the future, and
   `attestedAdapters` equal to `['policyEngine', 'costOps', 'dashboard']`.

4. **Timeout denies.** With a stub policy engine that sleeps past
   `GOVERNANCE_UPSTREAM_TIMEOUT_MS`, `POST /gate` returns **403** within the timeout budget
   plus a small margin — it neither hangs nor passes.

5. **Clearance is enforced downstream.** `POST /export` with no `clearance`, with a forged
   `clearanceId`, and with an `expiresAt` in the past each return **403**. Only a clearance
   freshly issued by case 3 returns `200`.

6. **No echo.** Assert that no HTTP response body from `/v1/policy/evaluate` contains a
   `evaluation_result` field equal to the request payload — a direct regression test
   against `src/server.ts:145`.

7. **Boot refuses on misconfiguration.** Starting the server with `POLICY_ENGINE_URL` unset
   and no explicit override exits non-zero rather than listening.

8. **Full suite runs.** `npm test` reports a non-zero test count covering all four files
   in `tests/`, and fails (non-zero exit) if any assertion fails.
