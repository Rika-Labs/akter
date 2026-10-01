# Customer stories

**Responsibility:** anchor design in real workloads.  
**Authority:** product.  
**Owner role:** product/architecture.
**Change policy:** a change requires product sign-off.

## Collaborative room

A named room actor owns membership and message rows. Commands serialize joins and sends in one transaction, events resume from a cursor, and typed connections broadcast best-effort typing and presence hints. Parked connections let idle rooms hibernate without dropping sockets while their transport remains alive; transport-process loss still requires reconnection and durable-event replay.

## Per-tenant workspace

A workspace actor owns settings, keyed state, and `OwnedTable` records. Authorized reporting reads across workspaces with SQL. `tenant_id` and optional row-level security isolate tenants; `shardGroup` places dedicated workloads without creating a database per tenant.

## Durable coding agent

A minted `CodingAgent` actor owns conversation rows, budget, approvals, committed outputs, and live connections. Model and tool calls are jobs with retries and dead letters. A long-running deliverable is an actor workflow that can sleep or `waitFor` an approval event. Token broadcasts are live hints; durable events and cursors recover the session. External tool generators consume OpenAPI.

## Order and payment

An order actor serializes state transitions and writes order rows with its receipt. Payment is a job using the provider's idempotency key; unknown outcomes remain visible for reconciliation. A fulfilment workflow belongs to the order and resumes after timers or events.

## Connected device

A device actor owns desired state, readings, and command history. `schedules` runs health checks, timers schedule follow-ups, and a typed connection handles live telemetry. Durable events preserve audit history when the device disconnects.

## Control plane

`Deployment`, singleton `Runners`, and `UsageMeter` actors in `packages/deployments` run embedded in `apps/api`. Jobs start or drain served customer runners; `apps/edge` handles hosted ingress. This is both a product story and the framework's first internal customer.

Each showcase must demonstrate contract, transaction, failure, recovery, realtime behavior, and operational inspection—not only a happy-path API call.
