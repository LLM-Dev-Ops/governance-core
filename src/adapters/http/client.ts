/**
 * Awaited, response-checked JSON transport for the concrete governance adapters.
 *
 * Every failure mode — DNS, connection refused, timeout, non-2xx, unparseable
 * body — is surfaced as `AdapterResponse{success: false}`. There is no path that
 * converts a failure into a success, because `enforceGovernanceGate` treats
 * `success: false` as a hard gate failure (src/lib.ts:397-399).
 */

import * as http from 'http';
import * as https from 'https';

import type { AdapterResponse } from '../index';

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 5000;

export interface HttpAdapterOptions {
  baseUrl: string;
  timeoutMs?: number;
  apiKey?: string;
}

interface RawResponse {
  statusCode: number;
  body: string;
}

function request(
  method: 'GET' | 'POST',
  baseUrl: string,
  path: string,
  payload: unknown,
  timeoutMs: number,
  apiKey?: string
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const transport = url.protocol === 'http:' ? http : https;

    const headers: Record<string, string> = { Accept: 'application/json' };
    let data: string | undefined;
    if (payload !== undefined) {
      data = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Upstream request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (data !== undefined) {
      req.write(data);
    }
    req.end();
  });
}

async function send<T>(
  method: 'GET' | 'POST',
  options: HttpAdapterOptions,
  path: string,
  payload: unknown,
  parse: (body: unknown) => T | null
): Promise<AdapterResponse<T>> {
  const target = `${method} ${new URL(path, options.baseUrl).href}`;
  let raw: RawResponse;

  try {
    raw = await request(
      method,
      options.baseUrl,
      path,
      payload,
      options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      options.apiKey
    );
  } catch (error) {
    return {
      success: false,
      error: `${target} failed: ${error instanceof Error ? error.message : 'Unknown transport error'}`,
    };
  }

  if (raw.statusCode < 200 || raw.statusCode >= 300) {
    return { success: false, error: `${target} returned HTTP ${raw.statusCode}` };
  }

  let decoded: unknown;
  try {
    decoded = raw.body.length > 0 ? JSON.parse(raw.body) : {};
  } catch {
    return { success: false, error: `${target} returned a body that is not valid JSON` };
  }

  const parsed = parse(decoded);
  if (parsed === null) {
    return { success: false, error: `${target} returned a body that does not match the expected shape` };
  }

  return { success: true, data: parsed, metadata: { statusCode: raw.statusCode } };
}

export function postJson<T>(
  options: HttpAdapterOptions,
  path: string,
  payload: unknown,
  parse: (body: unknown) => T | null
): Promise<AdapterResponse<T>> {
  return send('POST', options, path, payload, parse);
}

export function getJson<T>(
  options: HttpAdapterOptions,
  path: string,
  parse: (body: unknown) => T | null
): Promise<AdapterResponse<T>> {
  return send('GET', options, path, undefined, parse);
}

/** Accepts any 2xx JSON body — for endpoints whose response carries no decision. */
export function acknowledged(): void {
  return undefined;
}

export function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
