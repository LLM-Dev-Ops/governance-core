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

// ============================================================================
// Governance Gate Types
// ============================================================================

/**
 * Compliance posture produced by evaluating all mandatory governance adapters.
 * Represents the aggregate compliance state at a point in time.
 */
export interface CompliancePosture {
  /** Overall compliance status */
  status: 'compliant' | 'non_compliant' | 'degraded';

  /** Policy evaluation outcome */
  policyCompliance: {
    allowed: boolean;
    appliedPolicies: string[];
    reasons: string[];
  };

  /** Cost attribution and budget impact */
  costAttribution: {
    resourceId: string;
    currentCost: number;
    forecastedCost: number;
    budgetStatus: 'within' | 'warning' | 'exceeded';
    currency: string;
  };

  /** Dashboard health at time of evaluation */
  dashboardHealth: {
    healthy: boolean;
    details: Record<string, unknown>;
  };

  /** ISO-8601 timestamp when posture was evaluated */
  evaluatedAt: string;
}

/**
 * Clearance token proving a governance gate was successfully passed.
 * Contains a hash of the execution graph for tamper detection.
 */
export interface GateClearance {
  /** Unique clearance identifier */
  clearanceId: string;

  /** The request ID this clearance was issued for */
  requestId: string;

  /** ISO-8601 timestamp when clearance was issued */
  issuedAt: string;

  /** ISO-8601 timestamp when clearance expires */
  expiresAt: string;

  /** SHA-256 hash of the serialized ExecutionGraph */
  executionGraphHash: string;

  /** Names of the mandatory adapters that were successfully invoked */
  attestedAdapters: string[];

  /** The compliance posture at time of clearance */
  postureSnapshot: CompliancePosture;
}

/**
 * Result of the mandatory governance gate evaluation.
 */
export interface GovernanceGateResult {
  /** Whether the gate passed (all three mandatory adapters succeeded) */
  passed: boolean;

  /** The compliance posture assembled from all adapter results */
  posture: CompliancePosture;

  /** Clearance token — only present when gate passed */
  clearance?: GateClearance;

  /** Human-readable reasons for gate failure, if any */
  failureReasons: string[];

  /** The underlying governance decision */
  decision: GovernanceDecision;
}

/**
 * Request to export artifacts, requiring prior governance gate clearance.
 */
export interface ArtifactExportRequest {
  /** Unique export request identifier */
  exportId: string;

  /** Identifiers of artifacts to export */
  artifactIds: string[];

  /** Target destination */
  destination: string;

  /** Format for export */
  format?: string;

  /** Additional export metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of an artifact export operation.
 */
export interface ArtifactExportResult {
  /** The export request identifier */
  exportId: string;

  /** Whether the export succeeded */
  success: boolean;

  /** URIs of exported artifacts */
  exportedUris: string[];

  /** The clearance ID that authorized this export */
  authorizedBy: string;
}

/**
 * Request to map governance data to an ERP system, requiring prior gate clearance.
 */
export interface ERPMappingRequest {
  /** Unique mapping request identifier */
  mappingId: string;

  /** Target ERP system identifier */
  erpSystem: string;

  /** Resource identifiers to map */
  resourceIds: string[];

  /** Cost center or accounting code in the ERP */
  costCenter?: string;

  /** Additional mapping parameters */
  parameters?: Record<string, unknown>;
}

/**
 * Result of an ERP mapping operation.
 */
export interface ERPMappingResult {
  /** The mapping request identifier */
  mappingId: string;

  /** Whether the mapping succeeded */
  success: boolean;

  /** ERP-side reference identifiers created */
  erpReferences: string[];

  /** The clearance ID that authorized this mapping */
  authorizedBy: string;
}

// ============================================================================
// Lifecycle Event Types
// ============================================================================

/** Lifecycle event types that GovernanceCore subscribes to */
export type LifecycleEventType =
  | 'plan_created'
  | 'execution_completed'
  | 'deployment_started';

/**
 * Inbound lifecycle event from the platform orchestration layer.
 * GovernanceCore subscribes to these events to enforce governance on
 * plan, execution, and deployment lifecycle stages.
 */
export interface LifecycleEvent {
  /** Unique event identifier */
  eventId: string;

  /** The lifecycle event type */
  type: LifecycleEventType;

  /** ISO-8601 timestamp of when the event was produced */
  timestamp: string;

  /** Principal (user or service) that triggered the lifecycle event */
  principal: string;

  /** Resource affected by the lifecycle event */
  resourceId: string;

  /** Additional event-specific payload */
  payload: Record<string, unknown>;
}
