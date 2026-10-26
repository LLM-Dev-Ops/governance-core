import * as http from 'node:http';

import { getJson } from '../dist/adapters/http/client.js';
import { resolveUpstreamConfig } from '../dist/adapters/factory.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function testAcceptsBoundedResponse(): Promise<void> {
  await withServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ allowed: true }));
  }, async (baseUrl) => {
    const result = await getJson(
      { baseUrl, maxResponseBytes: 64 },
      '/',
      (body) => typeof body === 'object' && body !== null ? body : null
    );
    assert(result.success, 'response under the configured limit must succeed');
  });
  console.log('  testAcceptsBoundedResponse passed');
}

async function testRejectsAdvertisedOversizeResponse(): Promise<void> {
  await withServer((_req, res) => {
    const body = JSON.stringify({ value: 'x'.repeat(128) });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.end(body);
  }, async (baseUrl) => {
    const result = await getJson({ baseUrl, maxResponseBytes: 64 }, '/', () => ({ ok: true }));
    assert(!result.success, 'advertised oversized response must fail closed');
    assert(result.error?.includes('exceeded 64 bytes') === true, 'failure must identify the byte limit');
  });
  console.log('  testRejectsAdvertisedOversizeResponse passed');
}

async function testRejectsChunkedOversizeResponse(): Promise<void> {
  await withServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.write('{"value":"');
    res.write('x'.repeat(128));
    res.end('"}');
  }, async (baseUrl) => {
    const result = await getJson({ baseUrl, maxResponseBytes: 64 }, '/', () => ({ ok: true }));
    assert(!result.success, 'chunked oversized response must fail closed');
    assert(result.error?.includes('exceeded 64 bytes') === true, 'streaming limit must be enforced');
  });
  console.log('  testRejectsChunkedOversizeResponse passed');
}

async function testResponseLimitConfiguration(): Promise<void> {
  const urls = {
    POLICY_ENGINE_URL: 'https://policy.example',
    COSTOPS_URL: 'https://cost.example',
    GOVERNANCE_DASHBOARD_URL: 'https://dashboard.example',
    ANALYTICS_HUB_URL: 'https://analytics.example',
  };
  const config = resolveUpstreamConfig({
    ...urls,
    GOVERNANCE_UPSTREAM_MAX_RESPONSE_BYTES: '4096',
  } as NodeJS.ProcessEnv);
  assert(config.maxResponseBytes === 4096, 'configured response limit must be propagated');

  let threw = false;
  try {
    resolveUpstreamConfig({
      ...urls,
      GOVERNANCE_UPSTREAM_MAX_RESPONSE_BYTES: '1.5',
    } as NodeJS.ProcessEnv);
  } catch (error) {
    threw = error instanceof Error && error.message.includes('positive integer');
  }
  assert(threw, 'non-integer response limits must fail startup validation');
  console.log('  testResponseLimitConfiguration passed');
}

async function run(): Promise<void> {
  console.log('HTTP adapter response-bound tests');
  await testAcceptsBoundedResponse();
  await testRejectsAdvertisedOversizeResponse();
  await testRejectsChunkedOversizeResponse();
  await testResponseLimitConfiguration();
  console.log('All HTTP adapter response-bound tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
