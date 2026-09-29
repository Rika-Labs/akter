# Deployment

**Responsibility:** define supported operating shapes.  
**Authority:** operational.  
**Owner role:** operations/platform.
**Change policy:** a change requires operator review when a procedure or limit changes.

The intended deployment has one shared relational database and one `Actors.layer` runtime per runner process; a deployment may have multiple runners. These operating shapes describe the accepted design, not currently implemented deployment support:

- **Embedded:** provide `Actors.layer` from `@durable-actors/core/runtime` inside the application.
- **Served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI access.
- **Hosted:** deploy served containers on our runners behind `apps/edge`, with Neki; runners hold parked sockets.

The hosted control plane uses `packages/deployments`: `Deployment`, the `Runners` singleton, and `UsageMeter` run embedded in `apps/api`. `apps/edge` resolves deployment hosts to runners, converts API keys to `Principal`, routes each tenant to its home region from the tenant directory, signs a per-request assertion, enforces limits, and proxies client sockets to the runners that hold them ([ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md)). Infrastructure is Alchemy plus Railway.

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

## The hosted tenant directory

Implemented (M4.8, [ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md) §5): the control-plane database holds each hosted `deployment` with its `primary_region`, and the `tenant_directory` table maps `(deployment, tenant)` to `{ region, state, version }` (`packages/postgres/migrations/0002_tenant_directory.sql`). A tenant with no row lives in its deployment's primary region, and no request writes a row.

Only the `TenantHome` actor in `packages/deployments`, keyed by `<deployment>/<tenant>`, writes the directory, so every change is a receipted command attributed to its operator. Its `Create` command records the tenant's home and returns it again when repeated with the same region. It refuses an unknown deployment (`UnknownDeployment`), any region but the primary (`NotPrimaryRegion`), and a second region for a tenant that already has one (`TenantAlreadyHomed`), because moves wait for L.1. A trigger gives every insert and update the next `version` from one sequence, under a transaction-scoped advisory lock, so versions are assigned in commit order. A reader that holds every row up to version `v` can poll for rows above `v` and never skip a change that commits later with a lower number.

The operator command runs the control-plane actors embedded against the control-plane database:

```sh
durable tenants create acme --deployment dep-1 --region us-east \
  --database-url "$CONTROL_PLANE_DATABASE_URL" --operator ops@example.com
```

It prints `dep-1/acme lives in us-east (active)`, and exits with status 2 and the refusal otherwise. `--operator` names the `User` the receipt records. Deployments themselves are rows written by the `Deployment` actor once it exists; until then an operator inserts the `deployment` row. `durable tenants move` arrives with L.1.

## Embedded PGlite in production

Target, built by M4.14 ([ADR 0035](../decisions/0035-pglite-embedded-production-backend.md)). One process embeds `Actors.layer`, and optionally `Actor.serve`, with `Database.pglite({ dataDir })` on a local Linux or macOS filesystem. The layer locks the `dataDir`, so a second process fails with `DataDirLocked`. It recovers from a process crash to the last commit, but power-loss durability is not claimed. It runs one turn or query at a time on one connection, with no replicas, failover, or multi-runner support. Back it up by stopping the process and copying the `dataDir`. Move to Postgres with `DATABASE_URL` when those limits bind.
