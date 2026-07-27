/**
 * LLM-Governance-Core HTTP Server
 *
 * The deployed gate. `POST /gate` and `POST /evaluate` delegate to
 * `GovernanceCore.enforceGovernanceGate`, and `POST /export` / `POST /erp-map`
 * require a clearance this server actually issued. Every decision path fails
 * closed: an unreachable, slow, or malformed upstream is a denial.
 */

import * as http from 'http';
import * as https from 'https';
import { randomUUID } from 'node:crypto';

import {
  createAdapterCollection,
  resolveUpstreamConfig,
  UpstreamConfigurationError,
  type UpstreamConfig,
} from './adapters/factory';
import { GovernanceCore } from './lib';
import type { GateClearance, GovernanceGateResult, GovernanceRequest } from './types';

const MAX_BODY_BYTES = 1_000_000;

type DenialReason =
  | 'invalid_request'
  | 'upstream_unavailable'
  | 'gate_denied'
  | 'clearance_missing'
  | 'clearance_unknown'
  | 'clearance_invalid';

// ============================================================================
// Helpers
// ============================================================================

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('Body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function deny(res: http.ServerResponse, reason: DenialReason, failureReasons: string[], extra: Record<string, unknown> = {}): void {
  send(res, 403, { allowed: false, passed: false, reason, failureReasons, ...extra });
}

/**
 * Fire-and-forget POST to a downstream service, for advisory telemetry only.
 * Errors are logged but never propagated — which is why no response that claims
 * to carry a decision may be produced from a route that uses it.
 */
function fireAndForget(baseUrl: string, path: string, payload: unknown): void {
  const data = JSON.stringify(payload);
  const url = new URL(path, baseUrl);
  const transport = url.protocol === 'http:' ? http : https;

  const outReq = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    },
    (outRes) => {
      outRes.resume(); // drain response
    }
  );
  outReq.on('error', (err) => {
    console.error(`[route] ${url.href} error: ${err.message}`);
  });
  outReq.end(data);
}

function toGovernanceRequest(body: Record<string, unknown>): GovernanceRequest | string {
  const required = ['resourceId', 'action', 'principal'] as const;
  for (const field of required) {
    if (typeof body[field] !== 'string' || (body[field] as string).length === 0) {
      return `"${field}" is required and must be a non-empty string`;
    }
  }
  const context = body.context;
  return {
    requestId: typeof body.requestId === 'string' && body.requestId.length > 0 ? body.requestId : randomUUID(),
    resourceId: body.resourceId as string,
    action: body.action as string,
    principal: body.principal as string,
    context: typeof context === 'object' && context !== null && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : {},
  };
}

/**
 * Clearances this process issued, so that a caller cannot present a
 * structurally-plausible token it was never granted. Single-instance scope:
 * a clearance is redeemable only on the instance that issued it.
 */
class ClearanceRegistry {
  private readonly issued = new Map<string, GateClearance>();

  record(clearance: GateClearance): void {
    this.issued.set(clearance.clearanceId, clearance);
  }

  /** Returns the clearance as issued — never the caller's copy of it. */
  redeem(clearanceId: string): GateClearance | undefined {
    this.prune();
    return this.issued.get(clearanceId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, clearance] of this.issued) {
      if (new Date(clearance.expiresAt).getTime() <= now) {
        this.issued.delete(id);
      }
    }
  }
}

function readClearanceId(body: Record<string, unknown>): string | undefined {
  const clearance = body.clearance;
  if (typeof clearance === 'object' && clearance !== null && !Array.isArray(clearance)) {
    const id = (clearance as Record<string, unknown>).clearanceId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

// ============================================================================
// Server
// ============================================================================

export function createGovernanceServer(core: GovernanceCore, config: UpstreamConfig): http.Server {
  const registry = new ClearanceRegistry();

  /**
   * Runs the mandatory gate. A thrown error means an upstream could not be
   * consulted, which is a denial — never a pass.
   */
  async function runGate(
    request: GovernanceRequest
  ): Promise<{ result: GovernanceGateResult } | { error: string }> {
    try {
      return { result: await core.enforceGovernanceGate(request) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unknown gate failure' };
    }
  }

  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, {
        status: 'healthy',
        service: 'governance-core',
        version: process.env.npm_package_version || 'unknown',
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      send(res, 200, { service: 'llm-governance-core', version: '1.0.0' });
      return;
    }

    // ======================================================================
    // POST /v1/compliance/record — asynchronous record/forward. NOT a gate.
    // Callers must not treat a 202 here as authorization; use POST /gate.
    // ======================================================================

    if (req.method === 'POST' && req.url === '/v1/compliance/record') {
      try {
        const payload = await parseBody(req);
        const timestamp = new Date().toISOString();

        fireAndForget(config.costOpsUrl, '/api/v1/events', {
          source: payload.source,
          event: payload.event,
          cost_data: payload.cost_impact,
          timestamp,
        });
        fireAndForget(config.policyEngineUrl, '/api/evaluate', {
          context: payload,
          action: 'compliance_check',
        });
        fireAndForget(config.analyticsHubUrl, '/api/v1/events', payload);

        send(res, 202, {
          accepted: true,
          note: 'Forwarded for recording. This endpoint is not a governance gate and carries no decision.',
          routed_to: ['llm-costops', 'policy-engine', 'llm-analytics-hub'],
        });
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
      }
      return;
    }

    // ======================================================================
    // POST /v1/policy/evaluate — asynchronous forward. NOT a gate.
    // ======================================================================

    if (req.method === 'POST' && req.url === '/v1/policy/evaluate') {
      try {
        const payload = await parseBody(req);
        fireAndForget(config.policyEngineUrl, '/api/evaluate', {
          context: payload,
          action: payload.event,
        });

        send(res, 202, {
          accepted: true,
          note: 'Forwarded to the policy engine. This endpoint is not a governance gate and carries no decision — use POST /gate.',
          routed_to: ['policy-engine'],
        });
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
      }
      return;
    }

    // ======================================================================
    // POST /evaluate — real policy decision via the gate
    // ======================================================================

    if (req.method === 'POST' && req.url === '/evaluate') {
      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
        return;
      }

      const request = toGovernanceRequest(body);
      if (typeof request === 'string') {
        send(res, 400, { error: request });
        return;
      }

      const outcome = await runGate(request);
      if ('error' in outcome) {
        deny(res, 'upstream_unavailable', [outcome.error], { requestId: request.requestId });
        return;
      }

      const { decision, passed, failureReasons } = outcome.result;
      if (!passed) {
        deny(res, 'gate_denied', failureReasons, {
          requestId: request.requestId,
          policyResults: decision.policyResults,
          auditId: decision.auditId,
        });
        return;
      }

      send(res, 200, {
        allowed: decision.allowed,
        passed: true,
        requestId: request.requestId,
        policyResults: decision.policyResults,
        costImpact: decision.costImpact,
        auditId: decision.auditId,
      });
      return;
    }

    // ======================================================================
    // POST /gate — the mandatory governance gate
    // ======================================================================

    if (req.method === 'POST' && req.url === '/gate') {
      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
        return;
      }

      const request = toGovernanceRequest(body);
      if (typeof request === 'string') {
        send(res, 400, { error: request });
        return;
      }

      const outcome = await runGate(request);
      if ('error' in outcome) {
        deny(res, 'upstream_unavailable', [outcome.error], { requestId: request.requestId });
        return;
      }

      const { passed, failureReasons, posture, clearance } = outcome.result;
      if (!passed || !clearance) {
        deny(res, 'gate_denied', failureReasons, { requestId: request.requestId, posture });
        return;
      }

      registry.record(clearance);
      send(res, 200, {
        allowed: true,
        passed: true,
        requestId: request.requestId,
        clearance,
        posture,
        failureReasons: [],
      });
      return;
    }

    // ======================================================================
    // POST /export — requires a clearance this server issued
    // ======================================================================

    if (req.method === 'POST' && req.url === '/export') {
      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
        return;
      }

      const clearanceId = readClearanceId(body);
      if (!clearanceId) {
        deny(res, 'clearance_missing', ['A GateClearance issued by POST /gate is required']);
        return;
      }

      const clearance = registry.redeem(clearanceId);
      if (!clearance) {
        deny(res, 'clearance_unknown', [`No live clearance was issued with id "${clearanceId}"`]);
        return;
      }

      if (typeof body.exportId !== 'string' || !Array.isArray(body.artifactIds) || typeof body.destination !== 'string') {
        send(res, 400, { error: '"exportId", "artifactIds" and "destination" are required' });
        return;
      }

      try {
        const result = await core.exportArtifacts(
          {
            exportId: body.exportId,
            artifactIds: body.artifactIds.filter((id): id is string => typeof id === 'string'),
            destination: body.destination,
            format: typeof body.format === 'string' ? body.format : undefined,
          },
          clearance
        );
        send(res, 200, result);
      } catch (error) {
        deny(res, 'clearance_invalid', [error instanceof Error ? error.message : 'Export blocked']);
      }
      return;
    }

    // ======================================================================
    // POST /erp-map — requires a clearance this server issued
    // ======================================================================

    if (req.method === 'POST' && req.url === '/erp-map') {
      let body: Record<string, unknown>;
      try {
        body = await parseBody(req);
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : 'Invalid JSON body' });
        return;
      }

      const clearanceId = readClearanceId(body);
      if (!clearanceId) {
        deny(res, 'clearance_missing', ['A GateClearance issued by POST /gate is required']);
        return;
      }

      const clearance = registry.redeem(clearanceId);
      if (!clearance) {
        deny(res, 'clearance_unknown', [`No live clearance was issued with id "${clearanceId}"`]);
        return;
      }

      if (typeof body.mappingId !== 'string' || typeof body.erpSystem !== 'string' || !Array.isArray(body.resourceIds)) {
        send(res, 400, { error: '"mappingId", "erpSystem" and "resourceIds" are required' });
        return;
      }

      try {
        const result = await core.mapToERP(
          {
            mappingId: body.mappingId,
            erpSystem: body.erpSystem,
            resourceIds: body.resourceIds.filter((id): id is string => typeof id === 'string'),
            costCenter: typeof body.costCenter === 'string' ? body.costCenter : undefined,
          },
          clearance
        );
        send(res, 200, result);
      } catch (error) {
        deny(res, 'clearance_invalid', [error instanceof Error ? error.message : 'ERP mapping blocked']);
      }
      return;
    }

    send(res, 404, { error: 'Not found' });
  });
}

/**
 * Builds the adapter collection from the environment and returns a listening
 * server. Throws UpstreamConfigurationError if a mandatory upstream is unset.
 */
export function startServer(env: NodeJS.ProcessEnv = process.env): http.Server {
  const config = resolveUpstreamConfig(env);
  const core = new GovernanceCore(createAdapterCollection(env));
  const server = createGovernanceServer(core, config);
  const port = env.PORT || 8080;

  server.listen(port, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(
      `Server listening on port ${boundPort} | policy-engine=${config.policyEngineUrl} ` +
        `costops=${config.costOpsUrl} dashboard=${config.dashboardUrl} ` +
        `analytics-hub=${config.analyticsHubUrl} timeout=${config.timeoutMs}ms`
    );
  });

  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    if (error instanceof UpstreamConfigurationError) {
      console.error(error.message);
    } else {
      console.error(`Failed to start governance-core: ${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  }
}
