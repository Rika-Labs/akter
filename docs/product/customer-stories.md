# Customer stories

**Responsibility:** anchor design in real workloads.  
**Authority:** product.  
**Owner role:** product/architecture.

## Collaborative room

Room actor owns messages and membership mutations, emits message events, tracks presence, and reconnects subscriptions.

## Per-tenant workspace

Workspace actor owns settings and workflows while authorized reporting reads across workspaces through SQL.

## Durable agent

Agent actor owns conversation, budget, tool approvals, and accepted outputs. Model calls are activities; long plans are workflows.

## Order and payment

Order actor owns state transitions. Payment is an external effect with provider idempotency and unknown-outcome reconciliation.

## Document processing

Document actor owns metadata and processing status. Jobs create blobs; completion commands commit verified references.

Each story must have command, transaction, failure, realtime, and operational examples before it becomes a showcase.
