# 07 — Deployment and ownership

**Responsibility:** define deployment modes and operational ownership.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

The programming model and correctness contracts remain the same in three deployment shapes.

## Ways to run

- **Embedded:** provide `Actors.layer` from `@rikalabs/akter/runtime` inside an Effect application and call actor handles directly.
- **Served:** run `Actors.serve` from `@rikalabs/akter/runtime` in its own process. It exposes HTTP, WebSocket, SSE, and OpenAPI for browsers, other languages, and customer-operated runners.
- **Hosted:** a service can operate the same served runtime, with separate authentication, ingress, database, and provider verification. Akter Cloud's implementation is outside the public framework repository.

The hosted product consists of edge ingress and runners. A managed runner is the customer's served container coordinated by control-plane actors; it is not a separate framework model.

## Database and placement

Each deployment uses one Postgres database per region; most deployments have one region. A hosted deployment may add regions so remote users avoid cross-ocean round trips: every tenant has a home region, and its actors and rows live there. Tenants are rows identified by `tenant_id`, optionally reinforced with row-level security. `shardGroup` places compute and can select dedicated runner pools; Neki handles data placement within a region. Neither mechanism replaces authorization. See [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md).

## Operational ownership

Self-hosting must not require the hosted control plane. Operators need standard container, Postgres, migration, backup, and telemetry practices plus visibility into:

- actor generations, mailbox pressure, and activation lifecycle;
- receipt and event retention;
- workflow, timer, job, and dead-letter state;
- database saturation and shard placement;
- parked connections and replay gaps;
- drain, restore, and reconciliation progress.

Repository ownership follows the public model in [repository structure](../architecture/repository-structure.md): the framework, CLI, Cloud API contract, repo-only client tooling, and repository tooling remain here; Akter Cloud service code and provider infrastructure are separate.
