# Changelog

## 0.1.0-alpha.0 (unreleased)

The first published build of the framework, on the `alpha` npm dist-tag. It is an **alpha for a single runner**: run one runtime process per database, and expect APIs and stored formats to change between alphas without a migration path.

- Published as `@durable-actors/core` with four entries: the root, `/runtime`, `/client` (a placeholder until the Promise client lands), and `/testing`. Compiled ES modules and type declarations; the runtime requires Bun 1.4.2 or later.
- `Actor.make` with commands, queries (`X.Read`), and server reducers; minted, named, and singleton identities; creation, size, and mailbox policies; and receipts that replay results and declared failures for a retried command id.
- Keyed state in zstd with `Actor.state` migrations, actor-owned Drizzle tables (`Actor.table`), database blobs (`Actor.blob`), and durable events with cursor replay.
- One actor-shard outbox for intents, timers (`Intent.after`, `Intent.at`, `Intent.key`, `Intent.cancel`), and external effects (`Actor.effect`, `X.toEffectLayer`) with retries and dead-letter routes.
- `Actors.layer` on Postgres or PGlite with `maxResidentActors`; `ActorTest` and the shared conformance suite in `/testing`.
- Licensed under Apache-2.0.
