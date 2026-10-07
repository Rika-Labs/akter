# Changelog

## 0.1.0-alpha.2 (2026-10-07)

The framework and CLI release together on the `alpha` npm dist-tag. Alpha APIs and stored formats can change. Read the [upgrade notes](https://docs.akter.dev/operations/alpha-upgrades), back up the database, and stop all alpha.1 runners before starting alpha.2; mixed-alpha rolling upgrades are not established as safe.

### Breaking changes and required upgrades

- Operator commands read `AKTER_OPERATOR_TOKEN` instead of `DURABLE_OPERATOR_TOKEN`, with no implicit alias. Set the new variable or pass `--token-env` explicitly.
- The local inspector page and API move from `/_durable/inspector` to `/_akter/inspector`. Update bookmarks and requests; stored `durable` SQL schemas and format identifiers are unchanged.
- Hosted source deployment uses `src/app.ts` and a platform-generated Dockerfile. The cloud API removes `ContextPath`, exports `SOURCE_ENTRY`, and refuses `source.dockerfile` rather than silently ignoring it. Update source-upload clients and declare the hosted application with `App.make`.
- Cloud runtime activity and latency responses add `since`; absent latency percentiles are `null`, not zero. Live-only endpoints can return `NotImplemented` with multiple serving runners, and the command stream can end with `CommandStreamGap`. Update decoders and reconnection handling; unknown measurements are not zero.
- Direct SQL tools using single-table inspection views must join `durable.placements_v2` by `actor_type` for placement. Reapply view ownership and read grants for row-level-security roles after migrations. Tenant-to-authority placement moves change stored routing keys and require every old runner stopped before startup.

### Runtime reliability, routing and observability

- Commands cut off by runtime shutdown, or sent while or after it closes, settle with retryable `ActorUnavailable` instead of waiting indefinitely or exposing interruption. Retry with the original command id; a receipt committed before reply loss can still be replayed.
- Migration `0030_receipt_timing` records receipt start and commit timing on the database clock. Historical receipts keep unknown timing as `null`. Live telemetry adds bounded in-memory activity, latency, resident-actor, mailbox and connection measurements and a redacted command stream; it is not durable telemetry history or a fleet-wide aggregation.
- Migration `0031_routable_views` adds single-table `durable.*_v2` inspection views, including separate placement and content-sweep views, for routed layouts. Original joined views remain on an ordinary Postgres database; Neki tools use the routable set.
- Migration `0032_authority_placement` permits `placement: "authority"`. Neki statements target the data shard that owns their signed routing bucket, routed subscription cleanup uses a router-compatible query, and authority-placed actors keep control-plane turns on the authoritative shard. Provider-specific lab evidence does not make Neki a supported launch backend.
- Launch support is multi-runner on one host through `Runner.socket` and `Runner.mtls`, verified with three Bun processes sharing a Postgres database. Separate hosts and hosting providers still need their own evidence, and this does not certify every feature's multi-process behavior.

### First CLI release and public cloud contract

- Published Effect, Effect-platform/SQL and Drizzle peers accept compatible caret ranges instead of exact versions, so plain npm installs and applications already using a compatible Effect patch can share one Effect copy. Runtime dependencies and the tested workspace catalog remain exact; Effect is not added as a private runtime dependency.
- First release of `@rikalabs/akter-cli`, exposing the `akter` executable on Node 24+ and Bun 1.4.2+. Compiled ESM, declarations and the bundled inspector work without a Bun build on Node. The framework has no competing CLI bin; `@akter/cloud-api` stays private and is bundled into the CLI.
- `akter login` defaults to `https://api.akter.dev`; use `--api-url` or `AKTER_API_URL` for a dev preview or local stack. Cloud commands include source deploys and `akter env list`, `set`, `unset` and `import`.
- **PENDING ORCHESTRATOR FINALIZATION — `akter logs`:** the parallel customer-logs PR is intended for alpha.2. Finalize its behavior and verification here after it merges; this entry is not a claim that the command is in this candidate.
- The cloud API adds authenticated account export and deletion, organization deletion progress, optional deployment `environmentHost`, and card/Link payment-method variants. Account export excludes credentials; accepted organization deletion is not completed deletion.

### Repository, docs and release safety

- Hosted infrastructure, API, edge, console, marketing and provider integrations moved to the private Akter Cloud repository. The public repository retains the framework, CLI, cloud API contract, derived clients and Mintlify docs. Hosted deployment, billing, onboarding and website changes since alpha.1 are platform changes, not additional npm framework guarantees.
- Quickstart and deployment docs distinguish supported Node/Bun, embedded and server-backed scenarios from provider claims. Community contribution, security and support guidance is included.
- Verify now runs parallel shards; scheduled Stress and Nightly properties workflows and lease/fencing fixtures were repaired. Releases require a successful completed Verify run for the exact tagged commit, matching framework/CLI versions and version-specific notes before publication. npm publication has read-only contents permission; GitHub Release creation is a separate job.

## 0.1.0-alpha.1 (2026-10-04)

The first version published by the release workflow, through npm trusted publishing with provenance. The framework code is unchanged from `0.1.0-alpha.0`.

## 0.1.0-alpha.0 (2026-10-04)

The first published build of Akter, on the `alpha` npm dist-tag. Its release guidance was limited to one runtime process per database; that historical limit is not the current OSS launch claim above. Expect APIs and stored formats to change between alphas without a migration path.

- Published as `@rikalabs/akter` with four entries: the root, `/runtime`, `/client`, and `/testing`. Compiled ES modules and type declarations; the runtime requires Bun 1.4.2 or later, and `effect`, `@effect/sql-pg`, `@effect/sql-pglite` and `drizzle-orm` are exact-version peer dependencies.
- Built on Effect `4.0.0`.
- `Actor.make` with commands, queries, and reducers; minted, named, parent-placed, and singleton identities; creation, size, and mailbox policies; and receipts that replay results and declared failures for a retried command id.
- Keyed state with `Actor.state` migrations, actor-owned Drizzle tables (`Actor.table`), database blobs, tenant-scoped content blobs, and durable events with cursor replay.
- One actor-shard outbox for intents, timers, and jobs (`Actor.job`, `X.toJobLayer`) with retries, cancellation, and dead letters; workflows, cron and interval schedules, and cross-actor event subscriptions.
- Connections, streams, and broadcasts; `Actors.serve` over HTTP, WebSocket, SSE, OpenAPI, and MCP; the Promise client in `/client` with optimistic reducers, feeds, watches, and an offline command queue.
- `Actors.layer` on a Postgres database or file-backed PGlite; `ActorTest`, fault injection, and the shared conformance suite in `/testing`.
- A served `Schema.isPattern` check appears in the OpenAPI document only when its regular expression has the `u` flag.
- Licensed under Apache-2.0.
