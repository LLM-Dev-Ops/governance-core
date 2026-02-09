/**
 * LLM-Governance-Core HTTP Server
 * Minimal server for Cloud Run deployment
 */

import * as http from 'http';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
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

  if (req.method === 'POST' && req.url === '/evaluate') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
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
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
