# LLM-Governance-Core

A thin orchestration layer for LLM governance, providing unified coordination of policy evaluation, cost tracking, analytics, and audit logging across integrated services.

## Overview

LLM-Governance-Core is a **Layer-3 integration bundle** that acts as the central coordination point for governance operations. It does not implement core business logic—instead, it delegates to specialized upstream services via well-defined adapter interfaces.

### Design Principles

- **Thin Orchestration**: No retry logic, caching, or complex error handling—delegates to upstream services
- **Adapter-Based Integration**: All external services accessed through standardized adapter interfaces
- **Coordination Only**: Aggregates, orchestrates, and presents data from multiple sources
- **Schema-Validated Events**: Audit signals validated against schema registry before emission

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     LLM-Governance-Core                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   GovernanceCore                          │  │
│  │  • evaluateGovernance()  • resolveRBAC()                  │  │
│  │  • getFinOpsSummary()    • emitAuditSignal()              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────┴───────────────────────────────┐  │
│  │                    Adapter Layer                          │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │  │
│  │  │ Policy  │ │ CostOps │ │Analytics│ │ Schema  │          │  │
│  │  │ Engine  │ │         │ │   Hub   │ │Registry │          │  │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘          │  │
│  │  ┌────┴────┐ ┌────┴────┐                                  │  │
│  │  │ Config  │ │Dashboard│                                  │  │
│  │  │ Manager │ │         │                                  │  │
│  │  └─────────┘ └─────────┘                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │     External Services         │
              │  (Policy, Cost, Analytics,    │
              │   Config, Schema, Dashboard)  │
              └───────────────────────────────┘
```

## Installation

```bash
npm install llm-governance-core
```

## Quick Start

```typescript
import { createGovernanceCore, type AdapterCollection } from 'llm-governance-core';

// Configure adapters for your external services
const adapters: AdapterCollection = {
  policyEngine: myPolicyEngineAdapter,
  costOps: myCostOpsAdapter,
  analyticsHub: myAnalyticsAdapter,
  configManager: myConfigAdapter,
  schemaRegistry: mySchemaAdapter,
  dashboard: myDashboardAdapter,
};

// Create governance core instance
const governance = createGovernanceCore(adapters);

// Evaluate a governance request
const decision = await governance.evaluateGovernance({
  requestId: 'req-123',
  resourceId: 'model:gpt-4',
  action: 'llm:invoke',
  principal: 'user-456',
  context: { source: 'api' },
});

console.log(decision.allowed); // true or false
console.log(decision.policyResults); // Policy evaluation details
console.log(decision.costImpact); // FinOps summary
console.log(decision.auditId); // Audit trail ID
```

## API Reference

### GovernanceCore

The main orchestration class that coordinates governance operations.

#### `evaluateGovernance(request: GovernanceRequest): Promise<GovernanceDecision>`

Evaluates a governance request by coordinating policy evaluation, cost tracking, analytics, and audit logging.

**Parameters:**
- `request.requestId` - Unique identifier for the request
- `request.resourceId` - Resource being accessed (e.g., `model:gpt-4`)
- `request.action` - Action being performed (e.g., `llm:invoke`, `read`, `write`)
- `request.principal` - User or service making the request
- `request.context` - Optional additional context

**Returns:** `GovernanceDecision` containing:
- `allowed` - Whether the request is permitted
- `policyResults` - Detailed policy evaluation results
- `costImpact` - FinOps summary with current cost and forecast
- `auditId` - Identifier for audit trail

#### `resolveRBAC(principal: string): Promise<RBACContext>`

Resolves role-based access control context for a principal.

**Returns:** `RBACContext` containing:
- `principal` - The resolved principal
- `roles` - Assigned roles
- `permissions` - Derived permissions

#### `getFinOpsSummary(resourceId: string): Promise<FinOpsSummary>`

Retrieves financial operations summary for a resource.

**Returns:** `FinOpsSummary` containing:
- `resourceId` - The resource identifier
- `currentCost` - Current cost (30-day period)
- `forecast` - Projected cost
- `budgetStatus` - Status: `within`, `warning`, or `exceeded`

#### `emitAuditSignal(signal: AuditSignal): Promise<void>`

Validates and emits an audit signal to the governance dashboard.

## Adapter Interfaces

All external integrations are defined through adapter interfaces:

| Adapter | Purpose | Key Methods |
|---------|---------|-------------|
| `IPolicyEngineAdapter` | Policy evaluation | `evaluatePolicy()`, `validatePolicy()` |
| `ICostOpsAdapter` | Cost tracking | `getCostMetrics()`, `getForecast()` |
| `IAnalyticsHubAdapter` | Analytics events | `track()`, `query()` |
| `IConfigManagerAdapter` | Configuration | `getConfig()`, `getSecret()` |
| `ISchemaRegistryAdapter` | Schema validation | `validate()`, `getSchema()` |
| `IGovernanceDashboardAdapter` | Event publishing | `publishEvent()`, `publishMetrics()` |

## Services

Thin orchestration services for specific workflows:

```typescript
import {
  PolicyCoordinationService,
  AuditAggregationService,
  FinOpsOrchestrationService,
} from 'llm-governance-core';
```

- **PolicyCoordinationService** - Coordinates policy engine evaluation
- **AuditAggregationService** - Records governance decisions with schema validation
- **FinOpsOrchestrationService** - Combines cost and analytics data

## CLI

A command-line interface is available for testing:

```bash
# Evaluate a governance request
npx governance-cli evaluate --request '{"requestId":"r1","resourceId":"res1","action":"read","principal":"user1"}'

# Resolve RBAC for a principal
npx governance-cli rbac --principal user-123

# Get FinOps summary
npx governance-cli finops --resource model:gpt-4

# Emit an audit signal
npx governance-cli audit --signal '{"timestamp":"2025-01-01T00:00:00Z","action":"read","principal":"user1","resource":"res1","outcome":"allowed"}'

# Check health status
npx governance-cli health
```

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5.0+

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Project Structure

```
src/
├── lib.ts           # Core GovernanceCore class
├── types.ts         # Type definitions
├── sdk.ts           # Public API exports
├── cli.ts           # CLI interface
├── adapters/
│   └── index.ts     # Adapter interfaces
├── handlers/
│   └── index.ts     # Request handlers with validation
└── services/
    └── index.ts     # Orchestration services
```

## Layer-3 Compliance

This repository adheres to Layer-3 integration constraints:

- **No Infrastructure Duplication**: Does not implement retry logic, circuit breakers, caching, rate limiting, or logging infrastructure
- **No Product Boundary Violations**: All policy evaluation, cost tracking, analytics, and storage operations delegate to upstream services
- **Coordination Only**: Contains only orchestration, aggregation, and presentation logic

## License

MIT
