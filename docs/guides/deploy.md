---
title: "Deploy"
description: "Take an app from the quickstart to a production process on a Postgres database, and what is supported today."
---

# Deploy

**Responsibility:** take an app from the quickstart to a production process on a Postgres database, and state what is and is not supported today.

**Authority:** operational.  
**Owner role:** operations/platform.  
**Change policy:** change with the [support matrix](../operations/support-matrix.md) and [deployment](../operations/01-deployment.md) when a supported shape or limit changes; those documents win on any conflict.

## What is supported today

Akter is alpha. Before you deploy, know the limits the [support matrix](../operations/support-matrix.md) records:

- **Postgres server 18.6.** This is the server version CI tests and the launch-supported server range; other server versions are unverified. File-backed PGlite also supports one-process production within the limits of [embedded deployment](../operations/01-deployment.md#embedded-pglite-in-production), without multi-runner or power-loss guarantees.
- **Single runner or a TCP runner cluster.** `Runner.socket` is the public Postgres configuration for separate processes. Runners authenticate each other with mutual TLS (`Runner.mtls`). Three-process command, relay, singleton, schedule, SIGKILL, and rolling-drain drills run on one host; separate-host networks and hosting providers still require their own evidence.
- **Embedded or served.** `Actors.serve` serves commands, reducers, and queries over HTTP, connections over WebSocket, and feeds, streams, and watches over SSE. Core transport conformance runs on Bun's and Node's HTTP servers on loopback; no proxy, load balancer, or hosting provider has been verified by those cases. The three-process crash-drill claim is Bun-specific.
- **Self-host scope.** These instructions deploy the framework in your own processes. Akter Cloud's service implementation and provider verification are separate from the OSS launch claim; its client commands are in the [CLI reference](../api/06-cli.md).
- **Published package.** Install `@rikalabs/akter@alpha` from npm as in the [quickstart](../quickstart.md). `@akter/react` and the Python client generator remain repo-only at launch.

## The process

A deployed app builds the runtime over a Postgres server and, if clients call it over HTTP, serves it. The following inline entrypoint shows the shape:

```ts
const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DATABASE_URL")

    return RoomLive.pipe(
      Layer.provideMerge(
        Actors.layer({
          authorize: ({ caller, ref }) =>
            Effect.succeed(Schema.is(User)(caller) && ref.tenant === "chat-demo"),
        }),
      ),
      Layer.provide(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

HttpRouter.serve(routes).pipe(
  Layer.provide(runtime),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
)
```

`routes` is `Actors.serve({ actors: [Room], auth, openapi: { path: "/openapi.json" } })` from `@rikalabs/akter/runtime`. An embedded app, like the quickstart's `counter`, skips `Actors.serve` and calls its actors as Effects inside the same process.

## The database

- **Framework tables** are created and migrated when the runtime starts; see [migrations](../operations/02-migrations.md) for how startup refuses a database it cannot migrate safely.
- **Owned tables** are yours. Create and migrate them with drizzle-kit before the runtime starts; startup fails if a declared table is missing or claimed by another actor type.
- **State** upcasts through the migrations declared on `Actor.state`, one actor at a time, inside turns. No batch migration is needed.

Give the app its own database: the runtime records its retry window and each actor type's placement there, and a later start with different values fails. Keep the URL in a secret and pass it as `Redacted`.

## Several runners

Every process builds the same actor layers and shares the database, but advertises its own directly reachable private address. Runners can all start at once against an empty database: startup serializes creation of the migration bookkeeping and cluster tables. Provide `Runner.socket` to `Actors.layer` with `Runner.mtls` as its transport:

```ts
import { readFile } from "node:fs/promises"
import { Effect, Layer, Redacted } from "effect"
import { Actors, Database, Runner } from "@rikalabs/akter/runtime"

const runner = Runner.socket({
  address: { host: "runner-a.internal", port: 4400 },
  listenAddress: { host: "10.0.0.5", port: 4400 },
  transport: Runner.mtls({
    deployment: "shop-production",
    credentials: Effect.promise(async () => ({
      ca: await readFile("/etc/akter/peer/ca.pem", "utf8"),
      certificate: await readFile("/etc/akter/peer/certificate.pem", "utf8"),
      key: Redacted.make(await readFile("/etc/akter/peer/key.pem", "utf8")),
    })),
  }),
  shardsPerGroup: 256,
  shardLockExpiration: "35 seconds",
  shardLockRefreshInterval: "10 seconds",
})

const runtime = RoomLive.pipe(
  Layer.provideMerge(Actors.layer().pipe(Layer.provide(runner))),
  Layer.provide(
    Database.postgres({
      url: Redacted.make(databaseUrl),
      maxConnections: 20,
      offTurnConnections: 5,
    }),
  ),
)
```

Supply `BunCrypto.layer` as in the single-process example. The listener is separate from `Actors.serve` and uses NDJSON RPC over TLS 1.3, not HTTP. Each runner's certificate has exactly one subject alternative name, the URI `Runner.identity("shop-production")` (`spiffe://akter/deployment/shop-production`), and must chain to an authority in `ca`. A certificate with any other name besides it is refused. Session resumption is off, so every connection runs a full handshake. Both sides refuse a peer without a certificate, a plaintext peer, an untrusted or expired certificate, and a runner of another deployment before any runner message is exchanged. Any authority that can issue the URI SAN works (cert-manager, SPIRE, step-ca, AWS Private CA); `RunnerAuthority.make()` and `authority.issue({ deployment })` create development credentials.

`credentials` runs at startup and again every `refreshEvery` (default one minute). Replace the files to rotate without a restart: new connections use the new certificate, and established ones continue. To rotate the authority, first add the new authority to every runner's `ca` and wait a refresh, then replace each certificate and key with ones from the new authority, then remove the old authority. Credentials that fail validation on a refresh, or take longer than `refreshTimeout` (default 10 seconds) to load, are logged and the previous ones stay in use; at startup they stop the runner. Readiness reports `peering` once the current certificate has expired or loads have failed for `unhealthyAfter` (default 5 minutes), so a runner that can no longer peer leaves ingress. A peer's certificate is checked at the handshake only, so an expired or distrusted peer keeps an established session until either side reconnects.

The platform plaintext layers (`Layer.merge(layerSocketServer, layerClientProtocol)` from `@effect/platform-bun/BunClusterSocket`) remain available for a network isolated to one deployment's runners. They authenticate no one: any process that reaches the port can deliver runner messages.

`address` advertises a unique private DNS name or IP reachable directly by every peer, never a wildcard or a shared load-balancer address. `listenAddress` binds an interface and can differ; bind the private interface, and never expose the port to public clients, even over mutual TLS. Never run two incarnations at one address; keep it reserved until the old process exits and releases its locks. Prove your network's reachability and failure behavior before deploying across hosts.

Defaults are 256 shards per group, one-second assignment refresh, and expiring table locks with the singleton lease check. Survivors wait for the dead owner's expiration, and stale generations still fail the database fence. Advisory multi-runner locks are unsupported: the pinned storage assigns colliding lock IDs to distinct private holder groups ([ADR 0068](../decisions/0068-production-multi-runner.md)). Expiration defaults to 35 seconds and must be at least 3 seconds; Cluster caps lock refresh at a third of it. Polling, activation, and retries add time beyond expiration. `entityTerminationTimeout` defaults to 15 seconds and bounds activation shutdown during handoff.

Migration `0029_runner_configuration` records the first public runner's shard count and expiration. Later runners must match; an embedded runtime cannot join without `Runner.socket`. Stop the old embedded process before first enabling this configuration. To change a recorded layout, stop **every** runner, clear stale cluster registrations and locks, update the recorded configuration in maintenance, then restart all runners with matching values; never change layout during rolling deployment. Actor identities and receipts do not change.

Gate traffic on `RuntimeControl.readiness` or served `GET /ready`, not on a listening port. A configured runner reports `routing` until registered and holding every currently assigned shard, including its private holder group. This uses a fresh registration snapshot and local acquired shards, not actor activation. Assignments can change after a probe, so commands still retry normally.

## Sizing

Each runner owns its pools. Keep `processes × (maxConnections + offTurnConnections + queryConnections)`, plus the `coordination` pool's connections when configured, plus operator headroom below the database's `max_connections`.

- **Connections.** Each command holds one Postgres connection until its transaction ends; a pipelined chain keeps its session until the chain ends. `Database.postgres({ maxConnections })` defaults to 50, `offTurnConnections` and `queryConnections` to 10 each; count every pool targeting the server, plus migrations, backups, and operator sessions, under its `max_connections`. A pooler in front of a Postgres server is unverified.
- **Memory.** A resident actor holds about 20 KiB of JavaScript heap on the measured runner, so the default `maxResidentActors` of 10,000 is about 200 MiB. A command that needs a new activation past the limit fails `RunnerAtCapacity`, and its handle retries until an idle actor hibernates.

See [deployment](../operations/01-deployment.md#postgres-connections-across-runners) for the arithmetic.

## Serving over HTTP

- **TLS.** Serve `Actors.serve` behind TLS. Credentials and `Idempotency-Key` travel in headers, and the framework cannot tell whether a proxy terminates TLS, so it does not refuse plain HTTP.
- **Authentication.** `Actors.serve` requires an auth provider. Use `Auth.jwt({ issuer, audience, jwks, tenant })` from `@rikalabs/akter/runtime` for tokens from an identity provider, `Auth.make` for your own, and `Auth.none` only for deliberately public actors. Authorization is still your `authorize` callback.
- **Browsers.** List allowed browser origins in `origins`. Behind a proxy, list the public origin: forwarding headers are not trusted.
- **Clients.** The OpenAPI document at `openapi.path` generates clients in any language; see [generating clients](../api/05-generated-clients.md). Every client must keep one `Idempotency-Key` across its retries of a command.
- **Retry window.** `Actors.serve` refuses a runtime whose retry window is below 60 seconds. The default is one day.

## Releasing a new version

With one process, stop the old process and start the new one. With `Runner.socket`, start a compatible replacement, wait for readiness, remove the old runner from external traffic, call its `RuntimeControl.drain({ deadline: "30 seconds" })`, then close its runtime layer and stop it. Repeat one runner at a time. Drain makes it unready and stops claims; closing the layer releases shards. Retry interrupted commands under their original ids. The drills prove same-code rolling restart, not arbitrary mixed-version compatibility. Never remove decoders, workflow steps, or schemas still needed by durable work or surviving runners.

A command the old process had not committed is not applied. Retrying the same command id gives exactly one result: handles retry until `deliveryTimeout`, and HTTP clients resend the same `Idempotency-Key`. Pending work stays in the outbox for survivors or replacements. Zero loss through primary failover requires a synchronously replicated standby; asynchronous promotion can lose acknowledged commits regardless of runner configuration.

Before you release:

1. Apply owned-table migrations that the old and new code both accept (expand before contract).
2. If you changed a workflow, check that no open execution needs a removed or renamed step. Startup refuses such a deploy. `akter workflows check --entry <module> --database-url <url>`, from `apps/cli` in the repository (not yet published), runs the same check first.
3. Keep every event, job, and workflow payload decodable until the records that use it have passed their retention.

See [migrations](../operations/02-migrations.md) and [backup and restore](../operations/04-backup-restore.md).

## Checklist

- a Postgres database dedicated to this app, with `DATABASE_URL` in a secret.
- Owned-table migrations applied before start.
- `authorize` allows only the callers and tenants you expect, and `Actors.serve` has a real auth provider.
- TLS in front of the HTTP server, and `origins` set for browser clients.
- `maxConnections × processes` within the server's `max_connections`.
- One process per runner address, matching shard count and expiration across the database.
- A private peer network, direct advertisement, readiness gating, and drain before closing old runners.
- Logs collected: deterministic defects, dead-lettered jobs, and outbox retries are logged as warnings and errors. See [observability](../operations/03-observability.md).
