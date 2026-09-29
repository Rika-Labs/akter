# Deployment

**Responsibility:** define supported operating shapes.  
**Authority:** operational.  
**Owner role:** operations/platform.
**Change policy:** a change requires operator review when a procedure or limit changes.

The intended deployment has one shared relational database and one `Actors.layer` runtime per runner process; a deployment may have multiple runners. These operating shapes describe the accepted design, not currently implemented deployment support:

- **Embedded:** provide `Actors.layer` from `@durable-actors/core/runtime` inside the application.
- **Served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI access.
- **Hosted:** deploy served containers on our runners behind `apps/edge`, with Neki and parked sockets.

The hosted control plane uses `packages/deployments`: `Deployment`, the `Runners` singleton, and `UsageMeter` run embedded in `apps/api`. `apps/edge` resolves deployment hosts to runners, converts API keys to `Principal`, enforces limits, and owns parked client sockets. Infrastructure is Alchemy plus Railway.

The planned `durable` CLI lives in `apps/cli`: `login`, `dev`, `deploy`, `migrate`, and `dead-letters`. These commands are not implemented; the package has no bin until the first command exists. Customer-served deployments do not require the hosted control plane.

Before enabling multiple Railway replicas, prove that every replica advertises a private `railnet0` address reachable by every other replica. A one-service-per-runner alternative requires its own reachability and failover evidence; `Topology.k8s` is not part of the current API. Also verify singleton failover and Neki conformance before claiming those capabilities.

Intended deployment order: provision database and secrets; run framework and actor-table migrations; start compatible runners; verify readiness; route new traffic; drain old runners. Keep database URLs redacted and set auth explicitly—`Actor.serve` requires an auth policy.

## Postgres connections across runners

Each runner opens its own pool through `Database.postgres`, up to `maxConnections` (default 50). A command holds one connection for its whole turn, so under load a runner uses its whole pool, and idle connections close after 10 seconds. Size the pools against the server:

```text
runners × maxConnections + reserved ≤ max_connections
```

`reserved` covers `superuser_reserved_connections` (3 by default), migrations, backups, monitoring, and operator sessions. Postgres's default `max_connections` of 100 fits one runner at the default pool with that headroom, not two. For more runners either lower `maxConnections` per runner, for example 20 each for four runners, or raise `max_connections` with the memory the server has. A pooler in front of Postgres is unverified: turns rely on transaction-scoped `set_config`, row locks, and Cluster's SQL shard locks, and no pooler mode has been tested with them.

Measured on one machine (see [performance](../verification/03-performance.md#activation-residency-and-pools-across-runners-59)): under 64 callers each runner reached its pool size and no more, so peak connections were the sum of the runners' pools plus one connection outside them. With one runner and 64 callers over 10,000 actors, 50 connections lowered steady-state p99 against 25 in both runs (96 against 179 ms, and 130 against 166 ms). Those runners shared one process and CPU, so the runs show how connections add up across runners, not what latency separate runner processes would see; multi-runner operation is not yet supported (see the [support matrix](support-matrix.md)).

Memory bounds the other runner limit. A resident activation holds about 20 KiB of JavaScript heap, so the default `maxResidentActors` of 10,000 is about 200 MiB per runner before the rest of the process. Raise it only with the memory you give the process.

## Readiness and bounded graceful drain

The accepted behavior in [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md) requires usable storage, compatible schemas, registered actors, operational routing, and a runner that is not draining before advertising readiness. Listening on a port is insufficient; waking every actor or finishing all workflows is unnecessary.

Drain makes the runner unready, stops new local admission and acquisition of additional work, and waits for in-flight work within a bounded deadline. At expiry it interrupts remaining local execution, preserves pending durable obligations, and reports deadline expiry or forced shutdown distinctly from a clean drain. Release ownership only once the old writer cannot still commit; otherwise use safe expiry and fencing before takeover. A receipt committed before reply loss remains recoverable with the original command id.

Stopping an executor cannot undo a completed external call; ambiguous provider outcomes require reconciliation or proven idempotency. Parked sockets survive activation sleep, not transport-process shutdown. Draining one runner is not deployment-wide quiescence: [restore](04-backup-restore.md) also pauses ingress and all relevant execution.

`RuntimeControl` from `@durable-actors/core/runtime` implements this (M4.2); [the server API](../api/01-server-api.md#runtime-control-readiness-and-drain) lists its signatures. There is no default deadline: every `drain` names its own, so no timeout is an implied availability guarantee. The drained runner keeps its shard locks until its layer closes, so exit the process as soon as `drain` returns; a graceful exit hands the shards to the other runners at once, while a crash leaves them to lock expiry. Readiness answers `{ ready: false, reason }` with `draining`, `drained`, `storage`, `routing`, or `unregistered`; wire it into the orchestrator's readiness probe, since `Actor.serve` does not expose a readiness route. `conformance/drain.ts` covers clean and deadline-expired drains, new-work rejection, interrupted transactions, pending delivery, safe takeover, receipt replay, and provider ambiguity.
