# Changelog

## 0.1.0-alpha.1 (2026-10-04)

The first version published by the release workflow, through npm trusted publishing with provenance. The framework code is unchanged from `0.1.0-alpha.0`.

## 0.1.0-alpha.0 (2026-10-04)

The first published build of Akter, on the `alpha` npm dist-tag. It is an **alpha for a single runner**: run one runtime process per database, and expect APIs and stored formats to change between alphas without a migration path.

- Published as `@rikalabs/akter` with four entries: the root, `/runtime`, `/client`, and `/testing`. Compiled ES modules and type declarations; the runtime requires Bun 1.4.2 or later, and `effect`, `@effect/sql-pg`, `@effect/sql-pglite` and `drizzle-orm` are exact-version peer dependencies.
- Built on Effect `4.0.0`.
- `Actor.make` with commands, queries, and reducers; minted, named, parent-placed, and singleton identities; creation, size, and mailbox policies; and receipts that replay results and declared failures for a retried command id.
- Keyed state with `Actor.state` migrations, actor-owned Drizzle tables (`Actor.table`), database blobs, tenant-scoped content blobs, and durable events with cursor replay.
- One actor-shard outbox for intents, timers, and jobs (`Actor.job`, `X.toJobLayer`) with retries, cancellation, and dead letters; workflows, cron and interval schedules, and cross-actor event subscriptions.
- Connections, streams, and broadcasts; `Actors.serve` over HTTP, WebSocket, SSE, OpenAPI, and MCP; the Promise client in `/client` with optimistic reducers, feeds, watches, and an offline command queue.
- `Actors.layer` on Postgres or file-backed PGlite; `ActorTest`, fault injection, and the shared conformance suite in `/testing`.
- A served `Schema.isPattern` check appears in the OpenAPI document only when its regular expression has the `u` flag.
- Licensed under Apache-2.0.
