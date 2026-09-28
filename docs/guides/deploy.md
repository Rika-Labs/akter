# Deploy

**Responsibility:** take an app from the quickstart to a production process on Postgres, and state what is and is not supported today.  
**Authority:** operational.  
**Owner role:** operations/platform.  
**Change policy:** change with the [support matrix](../operations/support-matrix.md) and [deployment](../operations/01-deployment.md) when a supported shape or limit changes; those documents win on any conflict.

## What is supported today

Durable Actors is alpha. Before you deploy, know the limits the [support matrix](../operations/support-matrix.md) records:

- **Postgres only.** PGlite is for development and tests, one process per data directory. Production PGlite is not supported.
- **One runtime process per database.** Multi-runner operation has in-process evidence for some features but is not claimed for production.
- **Embedded or served over HTTP.** `Actor.serve` serves commands, reducers, and queries over HTTP, verified behind Bun's HTTP server on loopback. WebSocket and SSE are not served yet, and no proxy, load balancer, or hosting provider has been verified.
- **No managed hosting.** Hosted runners are planned.
- **Not on npm yet.** Install `@durable-actors/core` from a locally packed tarball, as in the [quickstart](../quickstart.md), until the first alpha release.

## The process

A deployed app is one Bun process that builds the runtime over Postgres and, if clients call it over HTTP, serves it. This is the `chat` example's `src/main.ts`:

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

`routes` is `Actor.serve({ actors: [Room], auth, openapi: { path: "/openapi.json" } })`. An embedded app, like the quickstart's `counter`, skips `Actor.serve` and calls its actors as Effects inside the same process.

## The database

- **Framework tables** are created and migrated when the runtime starts; see [migrations](../operations/02-migrations.md) for how startup refuses a database it cannot migrate safely.
- **Owned tables** are yours. Create and migrate them with drizzle-kit before the runtime starts; startup fails if a declared table is missing or claimed by another actor type.
- **State** upcasts through the migrations declared on `Actor.state`, one actor at a time, inside turns. No batch migration is needed.

Give the app its own database: the runtime records its retry window and each actor type's placement there, and a later start with different values fails. Keep the URL in a secret and pass it as `Redacted`.

## Sizing

- **Connections.** Each command holds one Postgres connection for its whole turn. `Database.postgres({ maxConnections })` defaults to 50; keep it plus migrations, backups, and operator sessions under the server's `max_connections`. A pooler in front of Postgres is unverified.
- **Memory.** A resident actor holds about 20 KiB of JavaScript heap on the measured runner, so the default `maxResidentActors` of 10,000 is about 200 MiB. A command that needs a new activation past the limit fails `RunnerAtCapacity`, and its handle retries until an idle actor hibernates.

See [deployment](../operations/01-deployment.md#postgres-connections-across-runners) for the arithmetic.

## Serving over HTTP

- **TLS.** Serve `Actor.serve` behind TLS. Credentials and `Idempotency-Key` travel in headers, and the framework cannot tell whether a proxy terminates TLS, so it does not refuse plain HTTP.
- **Authentication.** `Actor.serve` requires an auth provider. Use `Actor.auth.jwt({ issuer, audience, jwks, tenant })` for tokens from an identity provider, `Actor.auth.make` for your own, and `Actor.auth.none` only for deliberately public actors. Authorization is still your `authorize` callback.
- **Browsers.** List allowed browser origins in `origins`. Behind a proxy, list the public origin: forwarding headers are not trusted.
- **Clients.** The OpenAPI document at `openapi.path` generates clients in any language; see [generating clients](../api/05-generated-clients.md). Every client must keep one `Idempotency-Key` across its retries of a command.
- **Retry window.** `Actor.serve` refuses a runtime whose retry window is below 60 seconds. The default is one day.

## Releasing a new version

With one runtime process per database, a release stops the old process and starts the new one; rolling deploys with mixed versions are not claimed. A command the old process had not committed is not applied, and a caller that retries it with the same command id gets exactly one result: handles do this on their own until `deliveryTimeout`, and HTTP clients do it by resending the same `Idempotency-Key`. Pending intents, timers, and effects stay in the outbox until the new process delivers them.

Before you release:

1. Apply owned-table migrations that the old and new code both accept (expand before contract).
2. If you changed a workflow, check that no open execution needs a removed or renamed step. Startup refuses such a deploy. `durable workflows check --entry <module> --database-url <url>`, from `apps/cli` in the repository (not yet published), runs the same check first.
3. Keep every event, effect, and workflow payload decodable until the records that use it have passed their retention.

See [migrations](../operations/02-migrations.md) and [backup and restore](../operations/04-backup-restore.md).

## Checklist

- Postgres, a database for this app alone, and `DATABASE_URL` in a secret.
- Owned-table migrations applied before start.
- `authorize` allows only the callers and tenants you expect, and `Actor.serve` has a real auth provider.
- TLS in front of the HTTP server, and `origins` set for browser clients.
- `maxConnections × processes` within the server's `max_connections`.
- One runtime process per database.
- Logs collected: deterministic defects, dead-lettered effects, and outbox retries are logged as warnings and errors. See [observability](../operations/03-observability.md).
