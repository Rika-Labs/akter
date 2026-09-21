# 07 — Deployment and ownership

**Responsibility:** define deployment modes and operational ownership.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

The programming model and correctness contracts remain the same in three deployment shapes.

## Ways to run

- **Embedded:** provide `Actors.layer` from `durable-actors/runtime` inside an Effect application and call actor handles directly. The control-plane actors in `packages/deployments` run this way inside `apps/api`.
- **Served:** run `Actor.serve` in its own process. It exposes HTTP, WebSocket, SSE, and OpenAPI for browsers, other languages, and customer-operated runners.
- **Hosted:** run the same framework on our runners behind `apps/edge`, with Neki as the Postgres service.

The hosted product consists of edge ingress and runners. A managed runner is the customer's served container coordinated by control-plane actors; it is not a separate framework model.

## Database and placement

Each deployment uses one Postgres database. Tenants are rows identified by `tenant_id`, optionally reinforced with row-level security. `shardGroup` places compute and can select dedicated runner pools; Neki handles data placement. Neither mechanism replaces authorization.

## Operational ownership

Self-hosting must not require the hosted control plane. Operators need standard container, Postgres, migration, backup, and telemetry practices plus visibility into:

- actor generations, mailbox pressure, and activation lifecycle;
- receipt and event retention;
- workflow, timer, effect, and dead-letter state;
- database saturation and shard placement;
- parked connections and replay gaps;
- drain, restore, and reconciliation progress.

Repository ownership follows this model: `apps/{api,console,edge,cli}`, a `durable` CLI, the framework in `packages/durable-actors`, control-plane actors in `packages/deployments`, and runnable examples under `examples/`. See [repository structure](../architecture/repository-structure.md).
