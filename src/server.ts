/**
 * LLM-Governance-Core HTTP Server
 * Minimal server for Cloud Run deployment
 */

import * as http from 'http';
import * as https from 'https';

const PORT = process.env.PORT || 8080;

// ============================================================================
// Downstream Service URLs
// ============================================================================

const COSTOPS_URL = process.env.COSTOPS_URL || 'https://llm-costops-1062287243982.us-central1.run.app';
const POLICY_ENGINE_URL = process.env.POLICY_ENGINE_URL || 'https://policy-engine-1062287243982.us-central1.run.app';
const ANALYTICS_HUB_URL = process.env.ANALYTICS_HUB_URL || 'https://llm-analytics-hub-1062287243982.us-central1.run.app';

// ============================================================================
// Helpers
// ============================================================================

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

/**
 * Fire-and-forget HTTPS POST to a downstream service.
 * Errors are logged but never propagated to the caller.
 */
function fireAndForget(baseUrl: string, path: string, payload: unknown): void {
  const data = JSON.stringify(payload);
  const url = new URL(path, baseUrl);

  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  };

  const outReq = https.request(options, (outRes) => {
    outRes.resume(); // drain response
  });
  outReq.on('error', (err) => {
    console.error(`[route] ${url.href} error: ${err.message}`);
  });
  outReq.end(data);
}

// ============================================================================
// Server
// ============================================================================

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'governance-core',
      version: process.env.npm_package_version || 'unknown'
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ service: 'llm-governance-core', version: '1.0.0' }));
    return;
  }

  // ========================================================================
  // POST /v1/compliance/record
  // ========================================================================

  if (req.method === 'POST' && req.url === '/v1/compliance/record') {
    try {
      const payload = await parseBody(req);
      const timestamp = new Date().toISOString();
      const routedTo: string[] = [];

      // 1. CostOps — POST /api/v1/events
      fireAndForget(COSTOPS_URL, '/api/v1/events', {
        source: payload.source,
        event: payload.event,
        cost_data: payload.cost_impact,
        timestamp,
      });
      routedTo.push('llm-costops');

      // 2. Policy Engine — POST /api/evaluate
      const policyBody = { context: payload, action: 'compliance_check' };
      fireAndForget(POLICY_ENGINE_URL, '/api/evaluate', policyBody);
      routedTo.push('policy-engine');

      // 3. Analytics Hub — POST /api/v1/events (full payload)
      fireAndForget(ANALYTICS_HUB_URL, '/api/v1/events', payload);
      routedTo.push('llm-analytics-hub');

      res.writeHead(202);
      res.end(JSON.stringify({
        accepted: true,
        evaluation_result: policyBody,
        routed_to: routedTo,
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  // ========================================================================
  // POST /v1/policy/evaluate
  // ========================================================================

  if (req.method === 'POST' && req.url === '/v1/policy/evaluate') {
    try {
      const payload = await parseBody(req);
      const routedTo: string[] = [];

      // Policy Engine — POST /api/evaluate
      const policyBody = { context: payload, action: payload.event };
      fireAndForget(POLICY_ENGINE_URL, '/api/evaluate', policyBody);
      routedTo.push('policy-engine');

      res.writeHead(202);
      res.end(JSON.stringify({
        accepted: true,
        evaluation_result: policyBody,
        routed_to: routedTo,
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  // ========================================================================
  // Existing endpoints
  // ========================================================================

  if (req.method === 'POST' && req.url === '/evaluate') {
    try {
      const parsed = await parseBody(req);
      res.writeHead(200);
      res.end(JSON.stringify({
        accepted: true,
        requestId: parsed.requestId || null,
        message: 'Governance evaluation requires configured adapters. Use the SDK for full execution with span instrumentation.',
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/gate') {
    try {
      const parsed = await parseBody(req);
      res.writeHead(200);
      res.end(JSON.stringify({
        accepted: true,
        requestId: parsed.requestId || null,
        message: 'Governance gate enforcement requires configured adapters. Use the SDK for full execution with span instrumentation.',
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/export') {
    try {
      const parsed = await parseBody(req);
      res.writeHead(200);
      res.end(JSON.stringify({
        accepted: true,
        exportId: parsed.exportId || null,
        message: 'Artifact export requires a valid GateClearance from enforceGovernanceGate. Use the SDK.',
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/erp-map') {
    try {
      const parsed = await parseBody(req);
      res.writeHead(200);
      res.end(JSON.stringify({
        accepted: true,
        mappingId: parsed.mappingId || null,
        message: 'ERP mapping requires a valid GateClearance from enforceGovernanceGate. Use the SDK.',
      }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
