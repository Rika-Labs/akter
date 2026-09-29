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

## Postgres primary failover

A receipt, the state it covers, and the outbox rows staged with it commit in one transaction, so a failover keeps or loses them together. That makes two requirements:

- **Replicate synchronously to the standby you will promote.** Run the primary with `synchronous_commit` at `on` (the default) or `remote_apply`, and name that standby in `synchronous_standby_names`. A commit then returns only after the standby has flushed it, so every command a caller was told about survives promotion. With asynchronous replication a promoted replica can lack acknowledged commits: their receipts are gone, and a retry under the same command id runs the handler again on the older state.
- **Give runners one database address that moves.** Runners reconnect on their own through a DNS name or virtual IP that the failover moves to the promoted primary; they need no restart.

A turn whose `COMMIT` was sent when the primary died is commit-unknown. Its caller's retry under the same command id replays the receipt if the commit reached the standby, and runs the command once if it did not. Commands issued while the database is unreachable, including their command-id mint, fail `ActorUnavailable`, which handles retry. The [failover drill](../verification/01-conformance.md#postgres-primary-failover-drill-t10) measures this on three runner processes. It also records one limit: a command caught by the failover can wait its whole `deliveryTimeout` before its caller retries ([#243](https://github.com/Rika-Labs/durable-actors/issues/243)). The drill runs Cluster's table shard leases (`shardLockDisableAdvisory: true`); shard ownership by session advisory locks, which a failover drops, is not yet covered.

## Row-level security

Row-level security is opt-in defense in depth under the mandatory `tenant_id` predicates ([ADR 0051](../decisions/0051-row-level-security.md)). Migration `0018_rls` puts a `durable_tenant` policy on every tenant-bearing framework table, and `Actor.table` puts the same policy in each owned table's drizzle-kit migration. The policy admits only the tenant named by the transaction's `durable.tenant` setting. It exempts the table owner, so a deployment that doesn't opt in sees no change.

To opt in:

1. Run the framework and owned-table migrations, for example by starting one runner without the option.
2. As the table owner, create the tenant role and a separate view-owner role, and hand the inspection views to the view owner. Replace `public` with the runtime's schema and `runtime_login` with its login:

   ```sql
   CREATE ROLE durable_tenant NOLOGIN;
   GRANT USAGE ON SCHEMA public TO durable_tenant;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO durable_tenant;
   GRANT durable_tenant TO runtime_login;

   CREATE ROLE durable_views NOLOGIN;
   GRANT USAGE ON SCHEMA public TO durable_views;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO durable_views;
   GRANT durable_views TO CURRENT_USER;
   GRANT CREATE ON SCHEMA durable TO durable_views;
   DO $$ DECLARE v record; BEGIN
     FOR v IN SELECT relname FROM pg_class WHERE relnamespace = 'durable'::regnamespace AND relkind = 'v'
     LOOP EXECUTE format('ALTER VIEW durable.%I OWNER TO durable_views', v.relname); END LOOP;
   END $$;
   REVOKE CREATE ON SCHEMA durable FROM durable_views;
   ```

   `durable_views` must not be a superuser or have `BYPASSRLS`, must not own a table with RLS on, and must not be granted to `durable_tenant`. Otherwise the views would ignore the policies, or the role that runs turns could alter or drop a view.

3. Start every runner with `Actors.layer({ authorize, rowLevelSecurity: { role: "durable_tenant" } })`.

Command turns, queries, and every read that serves a caller outside a turn (feed pages, workflow polls, and the reads a stream or connection handler makes) then run as `durable_tenant` with their actor's tenant set, and the inspection views return only the tenant the reader's transaction names. The relay, executors, retention, and other cross-tenant framework work keep the connecting role. With the option on, each query or read outside a turn costs a transaction (`BEGIN`, the tenant settings, `COMMIT`); turns cost nothing more.

Rerun step 2 after any migration that adds a table or a view; a new view stays with the migrating role until you do. Until then, a runner with the option refuses to start and names the object ([runbooks](runbooks.md)). The role must not be a superuser or have `BYPASSRLS`, and the runtime's login must be able to `SET ROLE` to it.

## Readiness and bounded graceful drain

The accepted behavior in [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md) requires usable storage, compatible schemas, registered actors, operational routing, and a runner that is not draining before advertising readiness. Listening on a port is insufficient; waking every actor or finishing all workflows is unnecessary.

Drain makes the runner unready, stops new local admission and acquisition of additional work, and waits for in-flight work within a bounded deadline. At expiry it interrupts remaining local execution, preserves pending durable obligations, and reports deadline expiry or forced shutdown distinctly from a clean drain. Release ownership only once the old writer cannot still commit; otherwise use safe expiry and fencing before takeover. A receipt committed before reply loss remains recoverable with the original command id.

Stopping an executor cannot undo a completed external call; ambiguous provider outcomes require reconciliation or proven idempotency. Parked sockets survive activation sleep, not transport-process shutdown. Draining one runner is not deployment-wide quiescence: [restore](04-backup-restore.md) also pauses ingress and all relevant execution.

`RuntimeControl` from `@durable-actors/core/runtime` implements this (M4.2); [the server API](../api/01-server-api.md#runtime-control-readiness-and-drain) lists its signatures. There is no default deadline: every `drain` names its own, so no timeout is an implied availability guarantee. The drained runner keeps its shard locks until its layer closes, so exit the process as soon as `drain` returns; a graceful exit hands the shards to the other runners at once, while a crash leaves them to lock expiry. Readiness answers `{ ready: false, reason }` with `draining`, `drained`, `storage`, `routing`, or `unregistered`; `Actor.serve` answers it at `GET /ready` without credentials (`200`, or `503` with the reason; [ADR 0053](../decisions/0053-served-readiness-route.md)), so point the load balancer's or orchestrator's readiness probe there, and restart a runner only when the probe fails to connect, never on a `503`. The [runbook](runbooks.md#drain-a-runner) gives the required drain sequence. `conformance/drain.ts` covers clean and deadline-expired drains, new-work rejection, interrupted transactions, pending delivery, safe takeover, receipt replay, and provider ambiguity.

## The hosted tenant directory

Implemented (M4.8, [ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md) §5): the control-plane database holds each hosted `deployment` with its `primary_region`, and the `tenant_directory` table maps `(deployment, tenant)` to `{ region, state, version }` (`packages/postgres/migrations/0002_tenant_directory.sql`). A tenant with no row lives in its deployment's primary region, and no request writes a row.

Only the `TenantHome` actor in `packages/deployments`, keyed by `<deployment>/<tenant>`, writes the directory, so every change is a receipted command attributed to its operator. Its `Create` command records the tenant's home and returns it again when repeated with the same region. It refuses an unknown deployment (`UnknownDeployment`), any region but the primary (`NotPrimaryRegion`), and a second region for a tenant that already has one (`TenantAlreadyHomed`), because moves wait for L.1. A trigger gives every insert and update the next `version` from one sequence, under a transaction-scoped advisory lock, so versions are assigned in commit order. A reader that holds every row up to version `v` can poll for rows above `v` and never skip a change that commits later with a lower number.

The operator command runs the control-plane actors embedded against the control-plane database:

```sh
durable tenants create acme --deployment dep-1 --region us-east \
  --database-url "$CONTROL_PLANE_DATABASE_URL" --operator ops@example.com
```

It prints `dep-1/acme lives in us-east (active)`, and exits with status 2 and the refusal otherwise. `--operator` names the `User` the receipt records. Deployments themselves are rows written by the `Deployment` actor once it exists; until then an operator inserts the `deployment` row. `durable tenants move` arrives with L.1.

## The hosted edge

Implemented (M4.8, [ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md)): `apps/edge` is the only hosted ingress. For every request it does the following:

1. It maps the `Host` (lowercase, without a port) to a deployment through `deployment_host`. An unknown host is `404` before anything is authenticated.
2. It authenticates `authorization: Bearer` as a hosted API key (`hosted_api_key`, stored as its SHA-256, and read on every request so a revocation applies from the moment it commits) or as a JWT under the deployment's `deployment_jwt` settings. For a JWT, the tenant is a claim path or a fixed value.
3. It looks up the tenant's home region in the cached tenant directory.
4. It signs a 10-second assertion bound to the request and forwards it to a ready runner of that region from `deployment_runner`.

The edge removes `authorization` and any client `durable-assertion` before forwarding. A request without a credential is forwarded without an assertion, and the runner refuses it unless the route is public (`/protocol`, preflight).

WebSockets are proxied, and holders stay in runners. The edge verifies the `hello` and `reauthenticate` credentials. It replaces each with an assertion carrying the session's random `sid`, and its `cexp` is the credential's expiry. An API key has no expiry, so it gets `EDGE_API_KEY_SESSION` (default 5 minutes): that is the revocation bound of a session opened with an API key.

Configuration: `EDGE_ISSUER`, `CONTROL_PLANE_DATABASE_URL`, `EDGE_SIGNING_KEYS` (a secret JSON array of Ed25519 private JWKs `{ kid, x, d }`), `PORT`, `EDGE_ASSERTION_LIFETIME` (at most 60 seconds), and `EDGE_API_KEY_SESSION`.

At startup the edge publishes each key's public half to `edge_key`, and refuses to start if a `kid` is already published with a different public key, because a `kid` names one key for good. It signs only with a key that has been published for 5 minutes and is neither revoked nor expiring within an assertion's lifetime. Runners serve with `Actor.auth.assertion({ issuer, audience: <deployment id>, region, keys: new URL("<api>/edge/keys") })`; `apps/api` serves that key set. When an operator revokes a key (`edge_key.revoked_at`), every edge pushes a key-set refresh to each ready runner at `deployment_runner.url` (an origin such as `http://10.0.0.7:8080`, with no path) plus `base_path` (the runner's `Actor.serve` base path). A runner that doesn't accept the push is pushed again on every edge poll until it does or stops being ready, so runners refuse the key within seconds.

Hosts, runners, hosted API keys, and JWT settings have no writer yet. The `Deployment` and `Runners` actors and the accounts API keys will own them, so until then an operator writes the rows. Rate limits are not built.

## Embedded PGlite in production

Target, built by M4.14 ([ADR 0035](../decisions/0035-pglite-embedded-production-backend.md)). One process embeds `Actors.layer`, and optionally `Actor.serve`, with `Database.pglite({ dataDir })` on a local Linux or macOS filesystem. The layer locks the `dataDir`, so a second process fails with `DataDirLocked`. It recovers from a process crash to the last commit, but power-loss durability is not claimed. It runs one turn or query at a time on one connection, with no replicas, failover, or multi-runner support. Back it up by stopping the process and copying the `dataDir`. Move to Postgres with `DATABASE_URL` when those limits bind.
