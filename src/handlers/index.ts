/**
 * LLM-Governance-Core Request Handlers
 *
 * Thin request/response wrappers that validate inputs and delegate to core orchestration.
 * These are the entry points for external callers.
 */

import type {
  GovernanceRequest,
  GovernanceDecision,
  RBACContext,
  FinOpsSummary,
  AuditSignal,
} from '../types.js';

// ============================================================================
// GovernanceCore Interface
// ============================================================================

/**
 * Core orchestration interface that handlers depend on
 */
export interface GovernanceCore {
  evaluateGovernance(request: GovernanceRequest): Promise<GovernanceDecision>;
  resolveRBAC(principal: string): Promise<RBACContext>;
  getFinOpsSummary(resourceId: string): Promise<FinOpsSummary>;
  emitAuditSignal(signal: AuditSignal): Promise<void>;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateGovernanceRequest(request: unknown): asserts request is GovernanceRequest {
  if (!request || typeof request !== 'object') {
    throw new Error('Invalid request: must be an object');
  }

  const req = request as Record<string, unknown>;

  if (!req.requestId || typeof req.requestId !== 'string' || req.requestId.trim() === '') {
    throw new Error('Invalid request: requestId must be a non-empty string');
  }

  if (!req.resourceId || typeof req.resourceId !== 'string' || req.resourceId.trim() === '') {
    throw new Error('Invalid request: resourceId must be a non-empty string');
  }

  if (!req.action || typeof req.action !== 'string' || req.action.trim() === '') {
    throw new Error('Invalid request: action must be a non-empty string');
  }

  if (!req.principal || typeof req.principal !== 'string' || req.principal.trim() === '') {
    throw new Error('Invalid request: principal must be a non-empty string');
  }

  if (req.context !== undefined && (typeof req.context !== 'object' || req.context === null || Array.isArray(req.context))) {
    throw new Error('Invalid request: context must be an object if provided');
  }
}

function validatePrincipal(principal: unknown): asserts principal is string {
  if (typeof principal !== 'string' || principal.trim() === '') {
    throw new Error('Invalid principal: must be a non-empty string');
  }
}

function validateResourceId(resourceId: unknown): asserts resourceId is string {
  if (typeof resourceId !== 'string' || resourceId.trim() === '') {
    throw new Error('Invalid resourceId: must be a non-empty string');
  }
}

function validateAuditSignal(signal: unknown): asserts signal is AuditSignal {
  if (!signal || typeof signal !== 'object') {
    throw new Error('Invalid audit signal: must be an object');
  }

  const sig = signal as Record<string, unknown>;

  if (!sig.timestamp || typeof sig.timestamp !== 'string' || sig.timestamp.trim() === '') {
    throw new Error('Invalid audit signal: timestamp must be a non-empty string');
  }

  if (!sig.action || typeof sig.action !== 'string' || sig.action.trim() === '') {
    throw new Error('Invalid audit signal: action must be a non-empty string');
  }

  if (!sig.principal || typeof sig.principal !== 'string' || sig.principal.trim() === '') {
    throw new Error('Invalid audit signal: principal must be a non-empty string');
  }

  if (!sig.resource || typeof sig.resource !== 'string' || sig.resource.trim() === '') {
    throw new Error('Invalid audit signal: resource must be a non-empty string');
  }

  if (!sig.outcome || typeof sig.outcome !== 'string' || sig.outcome.trim() === '') {
    throw new Error('Invalid audit signal: outcome must be a non-empty string');
  }

  if (sig.metadata !== undefined && (typeof sig.metadata !== 'object' || sig.metadata === null || Array.isArray(sig.metadata))) {
    throw new Error('Invalid audit signal: metadata must be an object if provided');
  }
}

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handles incoming governance requests
 *
 * Validates the request structure and delegates to core orchestration for evaluation.
 *
 * @param request - The governance request to evaluate
 * @param core - GovernanceCore instance for delegation
 * @returns Promise resolving to governance decision
 * @throws Error if request validation fails
 */
export async function handleGovernanceRequest(
  request: GovernanceRequest,
  core: GovernanceCore
): Promise<GovernanceDecision> {
  // Validate request structure
  validateGovernanceRequest(request);

  // Delegate to core orchestration
  return await core.evaluateGovernance(request);
}

/**
 * Handles RBAC resolution for a principal
 *
 * Validates the principal identifier and delegates to core for role/permission resolution.
 *
 * @param principal - The principal identifier to resolve
 * @param core - GovernanceCore instance for delegation
 * @returns Promise resolving to RBAC context
 * @throws Error if principal validation fails
 */
export async function handleRBACResolution(
  principal: string,
  core: GovernanceCore
): Promise<RBACContext> {
  // Validate principal
  validatePrincipal(principal);

  // Delegate to core orchestration
  return await core.resolveRBAC(principal);
}

/**
 * Handles FinOps queries for a resource
 *
 * Validates the resource identifier and delegates to core for cost/budget information.
 *
 * @param resourceId - The resource identifier to query
 * @param core - GovernanceCore instance for delegation
 * @returns Promise resolving to FinOps summary
 * @throws Error if resourceId validation fails
 */
export async function handleFinOpsQuery(
  resourceId: string,
  core: GovernanceCore
): Promise<FinOpsSummary> {
  // Validate resourceId
  validateResourceId(resourceId);

  // Delegate to core orchestration
  return await core.getFinOpsSummary(resourceId);
}

/**
 * Handles audit signal emission
 *
 * Validates the audit signal structure and delegates to core for event emission.
 *
 * @param signal - The audit signal to emit
 * @param core - GovernanceCore instance for delegation
 * @returns Promise resolving when signal is emitted
 * @throws Error if signal validation fails
 */
export async function handleAuditEmission(
  signal: AuditSignal,
  core: GovernanceCore
): Promise<void> {
  // Validate signal structure
  validateAuditSignal(signal);

  // Delegate to core orchestration
  await core.emitAuditSignal(signal);
}
