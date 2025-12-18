/**
 * LLM-Governance-Core Types
 *
 * Data contracts for the governance orchestration layer.
 * These types represent the glue layer interface, not comprehensive domain models.
 */

/**
 * Incoming request for governance evaluation
 */
export interface GovernanceRequest {
  /** Unique identifier for this governance request */
  requestId: string;

  /** Identifier of the resource being accessed or modified */
  resourceId: string;

  /** Action being performed on the resource (e.g., "read", "write", "delete") */
  action: string;

  /** Principal (user, service, role) making the request */
  principal: string;

  /** Additional context for the request (e.g., metadata, attributes, environment) */
  context?: Record<string, unknown>;
}

/**
 * Result from policy engine delegation
 */
export interface PolicyEvaluationResult {
  /** Whether the action is allowed by policies */
  allowed: boolean;

  /** List of policy identifiers that were evaluated */
  policies: string[];

  /** Human-readable reasons for the decision */
  reasons: string[];
}

/**
 * Cost/usage summary from CostOps delegation
 */
export interface FinOpsSummary {
  /** Identifier of the resource being evaluated */
  resourceId: string;

  /** Current cost for the resource */
  currentCost: number;

  /** Forecasted cost for the resource */
  forecast: number;

  /** Status relative to budget (e.g., "within", "warning", "exceeded") */
  budgetStatus: string;
}

/**
 * Normalized audit event
 */
export interface AuditSignal {
  /** Timestamp of the event */
  timestamp: string;

  /** Action that was performed */
  action: string;

  /** Principal who performed the action */
  principal: string;

  /** Resource that was affected */
  resource: string;

  /** Outcome of the action (e.g., "allowed", "denied") */
  outcome: string;

  /** Additional metadata about the event */
  metadata?: Record<string, unknown>;

  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
}

/**
 * Final orchestrated governance decision
 */
export interface GovernanceDecision {
  /** Request identifier this decision corresponds to */
  requestId: string;

  /** Whether the request is allowed */
  allowed: boolean;

  /** Results from policy evaluation */
  policyResults: PolicyEvaluationResult;

  /** Cost impact information */
  costImpact?: FinOpsSummary;

  /** Audit identifier for tracking */
  auditId: string;
}

/**
 * Role-based access context
 */
export interface RBACContext {
  /** Principal identifier */
  principal: string;

  /** Roles assigned to the principal */
  roles: string[];

  /** Permissions derived from roles */
  permissions: string[];

  /** Scope or boundary for the permissions (e.g., org, project, resource) */
  scope?: string;
}
