# Changelog

## Unreleased

- **Breaking:** `Runner.socket` now throws the exported `RunnerConfigurationError` synchronously when `entityTerminationTimeout` exceeds `shardLockExpiration - min(shardLockRefreshInterval, shardLockExpiration / 3)`. Previously accepted unsafe configurations are refused, including a 3-second expiration with the omitted 15-second default termination timeout. Set an explicit timeout within the bound, or raise expiration to satisfy it; the ordinary defaults remain valid. See the [alpha upgrade notes](https://docs.akter.dev/operations/alpha-upgrades).

## 0.1.0-alpha.5 (2026-10-09)

The framework and CLI release together on the `alpha` and `latest` npm dist-tags. Stored formats and the default Postgres pool sizes are unchanged from alpha.4.

- Adds the supported opt-in `Database.postgres({ url, preset: "low-connection" })` preset: one turn, two off-turn and one query session, for four primary Postgres sessions per runner without read replicas. Explicit pool options override the preset. This uses direct Postgres connections; it does not establish transaction-pooler support.
- Real-Postgres evidence covers a held single turn session, progressing off-turn work, migration serialization, command deduplication and process recovery. See the [low-connection verification](https://docs.akter.dev/verification/low-connection-postgres) and [deployment guidance](https://docs.akter.dev/guides/deploy).
- Includes the compute-only Akter Cloud guides and deterministic offline/content conformance timing fixes; the CLI and bundled cloud API contract are unchanged from alpha.4.

## 0.1.0-alpha.4 (2026-10-09)

The framework and CLI release together on the `alpha` and `latest` npm dist-tags. The framework runtime and stored formats are unchanged from alpha.3; the hosted quota and cloud API contracts change during alpha.

- **Breaking:** `QuotaExceeded.cap` is now `compute`, `connections` or `spend`; `storage` is removed because Akter Cloud no longer supplies or bills managed databases. Only the connections cap remains retryable. HTTP 429 and WebSocket 1008 mappings are unchanged.
- **Breaking cloud API:** every environment uses customer Postgres through `DATABASE_URL`. The optional `Environment.database` report has source `customer`, state `missing`, `reachable` or `unreachable`, nullable p50 `latency` in milliseconds, boolean `latencyWarning`, and nullable integer `runnerCap`. A deploy probes from the runner region: p50 above 5 ms warns without refusing, and runner cap is `floor((max_connections - in_use - 10) / 9)`.
- **Breaking billing API:** base subscription plus compute unit-hours only. Removes every storage allowance, hard cap, price, meter, sample and per-project storage figure, plus storage and dedicated managed database plan features. The contract continues to ship at `@rikalabs/akter-cli/cloud-api`, not as a separate package.
- `akter env list` no longer marks variables `managed`. `akter deploy` confirms a live rollout and prints its matching database probe's latency warning and non-null runner cap, preserving zero and unknown measurements. Failed or superseded diagnostic reads warn without changing the successful exit status.
- Includes [#711](https://github.com/Rika-Labs/akter/pull/711): deploy following retries transient transport failures, typed `Unavailable` outages and unreadable 5xx responses with bounded exponential delays; refusals are never retried. Authentication declares `Unavailable`, so `whoami` reports a session-store outage without asking for another login.

## 0.1.0-alpha.3 (2026-10-08)

The framework and CLI release together on the `alpha` and `latest` npm dist-tags; verified-main canaries use only `next`. This launch release includes the unpublished alpha.2 draft and subsequent changes. Alpha APIs and stored formats can change. Read the [upgrade notes](https://docs.akter.dev/operations/alpha-upgrades), back up the database, and stop every earlier alpha runner before starting alpha.3; mixed-alpha rolling upgrades are not established as safe.

### Breaking changes and required upgrades

- `QuotaExceeded` now names the hard cap a hosted organization reached: `{ organizationId, period, cap, limit, used, retryAfterMs }`, where `cap` is `compute`, `storage`, `connections` or `spend`, and `limit` and `used` are in that cap's units (compute unit-hours, decimal gigabytes of pooled managed database storage, open connections, or cents). It no longer carries `limitUnits`, `usedUnits`, `requestedUnits` or `unitsPerCommand`, because commands and reads are no longer metered. Update decoders that read those fields. It is still answered 429 and closes a WebSocket with 1008.
- `SpendLimitExceeded`, `ConnectionLimitExceeded` and `StorageQuotaExceeded` are removed from `ActorError.reason` and from the exports of `@rikalabs/akter` and `@rikalabs/akter/client`; they existed only for the hosted edge. Match `QuotaExceeded` and its `cap` instead. A `connections` refusal is the only retryable one: `isRetryable` is true and the client retries it after `retryAfterMs` with the same command id, as it did for `ConnectionLimitExceeded`. A `spend` refusal is no longer answered 402 but 429.
- Operator commands read `AKTER_OPERATOR_TOKEN` instead of `DURABLE_OPERATOR_TOKEN`, with no implicit alias. Set the new variable or pass `--token-env` explicitly.
- The local inspector page and API move from `/_durable/inspector` to `/_akter/inspector`. Update bookmarks and requests; stored `durable` SQL schemas and format identifiers are unchanged.
- Hosted source deployment uses `src/app.ts` and a platform-generated Dockerfile. The cloud API removes `ContextPath`, exports `SOURCE_ENTRY`, and refuses `source.dockerfile` rather than silently ignoring it. Update source-upload clients and declare the hosted application with `App.make`.
- Cloud runtime activity and latency responses add `since`; absent latency percentiles are `null`, not zero. Live-only endpoints can return `NotImplemented` with multiple serving runners, and the command stream can end with `CommandStreamGap`. Update decoders and reconnection handling; unknown measurements are not zero.
- Neki support is removed completely, including the `Database.postgres` option, topology errors, targeted sessions and DDL mode. Postgres and PGlite are the only backends. Existing Neki deployments need a separately rehearsed export/restore to ordinary Postgres, not an in-place framework upgrade.
- Migration `0033_joined_inspection` removes the single-table `durable.*_v2` variants, including `placements_v2` and `content_sweeps_v2`. Update SQL tools to the original joined views, which already include placement; external dependencies refuse the migration without cascading. Stop every old alpha runner before upgrading. Tenant-to-authority placement conversions also require stopped old runners.
- `@rikalabs/akter/testing` no longer publishes framework conformance, foundation, cluster and simulation harnesses or `ActorTest.cluster`, `ActorTest.simulate` and `ActorTest.simulateCluster`. App-facing `ActorTest`, database fixtures, cleanup/content sweeps, batch-law checks and fault controls remain. Application tests using the removed alpha-only harnesses need their own process-level tests; framework maintainers use the private `tooling/conformance` workspace.

### Runtime reliability, routing and observability

- Commands cut off by runtime shutdown, or sent while or after it closes, settle with retryable `ActorUnavailable` instead of waiting indefinitely or exposing interruption. Retry with the original command id; a receipt committed before reply loss can still be replayed.
- Migration `0030_receipt_timing` records receipt start and commit timing on the database clock. Historical receipts keep unknown timing as `null`. Live telemetry adds bounded in-memory activity, latency, resident-actor, mailbox and connection measurements and a redacted command stream; it is not durable telemetry history or a fleet-wide aggregation.
- Applied migrations are unchanged; `0033` retires the variants introduced by `0031` transactionally while preserving the original joined-view grants and versions.
- Migration `0032_authority_placement` permits `placement: "authority"`. Its existing bucket -128 encoding and transactional conversion remain logical grouping, not physical data-shard placement or authorization. Generic routing keys, bucket-range scheduling and independent coordination remain.
- Launch support is multi-runner on one host through `Runner.socket` and `Runner.mtls`, verified with three Bun processes sharing a Postgres database. Separate hosts and hosting providers still need their own evidence, and this does not certify every feature's multi-process behavior.

### First CLI release and public cloud contract

- Published Effect, Effect-platform/SQL and Drizzle peers accept compatible caret ranges instead of exact versions, so plain npm installs and applications already using a compatible Effect patch can share one Effect copy. The Effect/platform/SQL cohort and its peer floors are 4.0.2; development verification uses Vitest 5.0.3. Runtime dependencies and the tested workspace catalog remain exact; Effect is not added as a private runtime dependency.
- First release of `@rikalabs/akter-cli`, exposing the `akter` executable on Node 24+ and Bun 1.4.2+. Compiled ESM, declarations and the bundled inspector work without a Bun build on Node. The framework has no competing CLI bin; `@akter/cloud-api` stays private and ships as compiled JS and declarations at `@rikalabs/akter-cli/cloud-api`. Importing the subpath does not execute the CLI; there is no standalone cloud API npm package.
- `akter login` defaults to `https://api.akter.dev`; use `--api-url` or `AKTER_API_URL` for a dev preview or local stack. Cloud commands include source deploys and `akter env list`, `set`, `unset` and `import`.
- `akter logs` reads recent customer runner output for a project and environment (default `production`) or one `--deployment`, bounded by `--since` (1 to 3600 seconds, default 300, clamped by the server to the last hour) and `--limit` (1 to 200 lines per page, default 100). Recent mode reads every page and exits; `--follow` drains pages, then long-polls for up to 20 seconds, resuming from the last successful cursor after transport failures and `Unavailable` responses and stopping after six failed requests in a row. Denied, missing and unsupported requests are not retried, and Ctrl-C exits with code 130. Terminal control characters are replaced, clipped lines end in `…`, and Fly lines show stream `unknown`. See the [logs API contract](https://github.com/Rika-Labs/akter/blob/main/docs/api/07-cloud-logs.md).
- The cloud API adds authenticated account export and deletion, organization deletion progress, optional deployment `environmentHost`, and card/Link payment-method variants. Account export excludes credentials; accepted organization deletion is not completed deletion.
- Cloud environment `database` now reports `{ source, state }` without an engine or Neki mode. Billing schemas remove command/read allowances and meters and deprecated compatibility fields, using compute unit-hours and pooled managed database storage instead; customer-owned databases do not count toward that storage pool. Update cloud API clients to the new required fields rather than interpreting missing measurements as zero.

### Repository, docs and release safety

- Hosted infrastructure, API, edge, console, marketing and provider integrations moved to the private Akter Cloud repository. The public repository retains the framework, CLI, cloud API contract, derived clients and Mintlify docs. Hosted deployment, billing, onboarding and website changes since alpha.1 are platform changes, not additional npm framework guarantees.
- Quickstart and deployment docs distinguish supported Node/Bun, embedded and server-backed scenarios from provider claims. Community contribution, security and support guidance is included.
- Verify runs parallel shards on GitHub-hosted runners; scheduled Stress and Nightly properties workflows and lease/fencing fixtures were repaired. Releases require a successful completed Verify run for the exact tagged commit, matching framework/CLI versions and version-specific notes before publication. Tagged pre-1.0 releases also advance `latest`, while verified main canaries publish only to `next`. npm publication has read-only contents permission; GitHub Release creation is a separate job. The CLI's first publication still requires a maintainer bootstrap before OIDC-only workflow publishing.

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
