/**
 * LLM-Governance-Core Lifecycle Subscriber
 *
 * Subscribes to platform lifecycle events (plan_created, execution_completed,
 * deployment_started) and enforces governance on each stage:
 *   1. Resolves RBAC for the event principal
 *   2. Checks the principal has the required permission for the event type
 *   3. Records an audit signal for the event
 *   4. Publishes a governance_recorded event to the dashboard
 */

import type {
  LifecycleEvent,
  LifecycleEventType,
  AuditSignal,
} from '../types';

import type {
  AdapterCollection,
  AdapterResponse,
} from '../adapters';

import type { GovernanceCore } from '../lib';
import { ExecutionContext } from '../execution/context';
import { createArtifact } from '../execution/spans';
import type { CoreExecutionResult } from '../execution/types';
import type { ExecutionOptions } from '../lib';

// ============================================================================
// Constants
// ============================================================================

/** The set of lifecycle events this subscriber handles */
const SUBSCRIBED_EVENTS: readonly LifecycleEventType[] = [
  'plan_created',
  'execution_completed',
  'deployment_started',
] as const;

/** Maps lifecycle event types to required RBAC permissions */
const EVENT_PERMISSION_MAP: Record<LifecycleEventType, string> = {
  plan_created: 'governance:lifecycle:plan',
  execution_completed: 'governance:lifecycle:execution',
  deployment_started: 'governance:lifecycle:deployment',
};

// ============================================================================
// Result Types
// ============================================================================

export interface LifecycleHandlerResult {
  /** The lifecycle event that was processed */
  eventId: string;

  /** Whether governance processing succeeded */
  accepted: boolean;

  /** The audit ID recorded for this event */
  auditId: string;

  /** RBAC outcome: whether the principal was authorized */
  authorized: boolean;

  /** Reasons for denial, if not authorized */
  reasons: string[];
}

// ============================================================================
// LifecycleSubscriber
// ============================================================================

/**
 * Subscribes to platform lifecycle events and enforces governance on each.
 *
 * Usage:
 *   const subscriber = new LifecycleSubscriber(core, adapters);
 *   const result = await subscriber.handleEvent(event);
 */
export class LifecycleSubscriber {
  private core: GovernanceCore;
  private adapters: AdapterCollection;

  constructor(core: GovernanceCore, adapters: AdapterCollection) {
    this.core = core;
    this.adapters = adapters;
  }

  /**
   * Returns the set of lifecycle event types this subscriber handles.
   */
  get subscribedEvents(): readonly LifecycleEventType[] {
    return SUBSCRIBED_EVENTS;
  }

  /**
   * Process an inbound lifecycle event.
   *
   * Steps:
   *   1. Validate the event type is one we subscribe to
   *   2. Resolve RBAC for the principal
   *   3. Check the principal has the required permission
   *   4. Record an audit signal (allowed or denied)
   *   5. Publish governance_recorded to dashboard
   */
  async handleEvent(event: LifecycleEvent): Promise<LifecycleHandlerResult>;
  async handleEvent(
    event: LifecycleEvent,
    options: ExecutionOptions
  ): Promise<CoreExecutionResult<LifecycleHandlerResult>>;
  async handleEvent(
    event: LifecycleEvent,
    options?: ExecutionOptions
  ): Promise<LifecycleHandlerResult | CoreExecutionResult<LifecycleHandlerResult>> {
    const ctx = new ExecutionContext(
      'lifecycleSubscriber.handleEvent',
      options?.parentSpanId ?? null
    );

    let result: LifecycleHandlerResult | undefined;

    try {
      // 1. Validate event type
      if (!SUBSCRIBED_EVENTS.includes(event.type)) {
        throw new Error(
          `Unsupported lifecycle event type: ${event.type}. ` +
          `Supported: ${SUBSCRIBED_EVENTS.join(', ')}`
        );
      }

      // 2. Resolve RBAC for the principal
      const rbacSpanId = ctx.startRepoSpan('configManager');
      const rbacContext = await this.core.resolveRBAC(event.principal);
      ctx.closeRepoSpan(rbacSpanId, { success: true, data: rbacContext }, [
        createArtifact('lifecycle-rbac', 'rbac-context', { id: event.principal }),
      ]);

      // 3. Check required permission
      const requiredPermission = EVENT_PERMISSION_MAP[event.type];
      const authorized = rbacContext.permissions.includes(requiredPermission);
      const reasons: string[] = [];

      if (!authorized) {
        reasons.push(
          `Principal "${event.principal}" lacks permission "${requiredPermission}" ` +
          `for event type "${event.type}"`
        );
      }

      // 4. Record audit signal
      const auditId = `audit-lifecycle-${event.eventId}-${Date.now()}`;
      const auditSignal: AuditSignal = {
        timestamp: new Date().toISOString(),
        action: `lifecycle:${event.type}`,
        principal: event.principal,
        resource: event.resourceId,
        outcome: authorized ? 'allowed' : 'denied',
        metadata: {
          eventId: event.eventId,
          eventType: event.type,
          requiredPermission,
          principalRoles: rbacContext.roles,
          principalPermissions: rbacContext.permissions,
          reasons,
          payload: event.payload,
        },
      };

      await this.core.emitAuditSignal(auditSignal);

      // 5. Publish governance_recorded to dashboard
      const dashboardSpanId = ctx.startRepoSpan('dashboard');
      const dashboardResponse = await this.adapters.dashboard.publishEvent({
        eventType: 'governance_recorded',
        severity: authorized ? 'info' : 'warning',
        timestamp: new Date(),
        details: {
          auditId,
          lifecycleEventId: event.eventId,
          lifecycleEventType: event.type,
          principal: event.principal,
          resourceId: event.resourceId,
          authorized,
          reasons,
        },
      });
      ctx.closeRepoSpan(dashboardSpanId, dashboardResponse, [
        createArtifact('governance-recorded', 'dashboard-event', { id: auditId }),
      ]);

      result = {
        eventId: event.eventId,
        accepted: true,
        auditId,
        authorized,
        reasons,
      };
    } catch (error) {
      const execution = ctx.finalize('FAILED');
      if (options?.includeExecution) {
        return { result: undefined, execution };
      }
      throw new Error(
        `Lifecycle event handling failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    const execution = ctx.finalize();

    if (options?.includeExecution) {
      return { result, execution };
    }
    return result;
  }
}
