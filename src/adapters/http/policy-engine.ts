/**
 * Concrete IPolicyEngineAdapter over POLICY_ENGINE_URL.
 *
 * A response is only accepted as a decision when it carries a boolean `allowed`.
 * Anything else — unreachable host, timeout, non-2xx, missing `allowed` — is
 * reported as a failure, which the gate converts into a denial.
 */

import type {
  AdapterResponse,
  IPolicyEngineAdapter,
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
} from '../index';
import { acknowledged, asRecord, asStringArray, postJson, type HttpAdapterOptions } from './client';

export const POLICY_EVALUATE_PATH = '/api/evaluate';
export const POLICY_VALIDATE_PATH = '/api/policies/validate';
export const POLICY_REFRESH_PATH = '/api/policies/refresh';

function parseEvaluation(body: unknown): PolicyEvaluationResult | null {
  const record = asRecord(body);
  if (!record) return null;

  // Some deployments wrap the decision in a `result` / `data` envelope.
  const decision = asRecord(record.result) ?? asRecord(record.data) ?? record;
  if (typeof decision.allowed !== 'boolean') return null;

  return {
    allowed: decision.allowed,
    reasons: asStringArray(decision.reasons),
    appliedPolicies: asStringArray(decision.appliedPolicies ?? decision.applied_policies),
    conditions: asRecord(decision.conditions) ?? undefined,
  };
}

function parseValidation(body: unknown): { valid: boolean; errors: string[] } | null {
  const record = asRecord(body);
  if (!record || typeof record.valid !== 'boolean') return null;
  return { valid: record.valid, errors: asStringArray(record.errors) };
}

export class HttpPolicyEngineAdapter implements IPolicyEngineAdapter {
  constructor(private readonly options: HttpAdapterOptions) {}

  evaluatePolicy(request: PolicyEvaluationRequest): Promise<AdapterResponse<PolicyEvaluationResult>> {
    return postJson(
      this.options,
      POLICY_EVALUATE_PATH,
      {
        action: request.action,
        principal: request.principal,
        resource: request.resource,
        context: request.context,
      },
      parseEvaluation
    );
  }

  validatePolicy(
    policyDefinition: Record<string, unknown>
  ): Promise<AdapterResponse<{ valid: boolean; errors: string[] }>> {
    return postJson(this.options, POLICY_VALIDATE_PATH, { policy: policyDefinition }, parseValidation);
  }

  refreshPolicies(): Promise<AdapterResponse<void>> {
    return postJson(this.options, POLICY_REFRESH_PATH, {}, acknowledged);
  }
}
