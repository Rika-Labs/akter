# Research sources

Research date: 2026-09-17. Pinned implementation observations are distinguished from reference pages requiring provider/version verification. Exact current dependency availability is recorded in toolchain.lock.json and VALIDATION.md.

## E01 — Effect v4 package snapshot

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json
- Evidence class: pinned source
- Use: Inspected source snapshot identifies 4.0.0-rc.115. A repository version is not proof that every registry artifact is available.

## E02 — Effect Cluster entity example

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts
- Evidence class: pinned source
- Use: Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.

## E03 — SQL runner ownership

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts
- Evidence class: pinned source
- Use: Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.

## E04 — Cluster message persistence contract

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts
- Evidence class: pinned source
- Use: Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.

## E05 — Workflow Activity

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts
- Evidence class: pinned source
- Use: Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.

## E06 — Effect EventLog

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/eventlog/EventLog.ts
- Evidence class: pinned source
- Use: Typed handler runs before journal entry commits; not interchangeable with a database CDC broker.

## E07 — Effect libSQL package

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/sql/libsql/package.json
- Evidence class: pinned source
- Use: Inspected rc.115 package depends on @libsql/client ^0.18.0.

## E08 — Effect Vitest package

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/vitest/package.json
- Evidence class: pinned source
- Use: Inspected rc.115 package requires Vitest >=5 <6.

## E09 — Effect SQL client

- Source: https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts
- Evidence class: pinned source reference
- Use: Transaction and reserved-connection API reference; bind each database role independently.

## E10 — Effect v4 API index

- Source: https://effect.website/docs/v4/api/effect
- Evidence class: official documentation
- Use: Module availability and unstable import paths. Supplied user export also inspected.

## E11 — Effect TypeScript-Go tooling

- Source: https://github.com/Effect-TS/tsgo/blob/main/README.md
- Evidence class: source
- Use: Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.

## E12 — Effect Oxlint integration guide

- Source: https://github.com/Effect-TS/tsgo/blob/main/docs/README.md
- Evidence class: source
- Use: Resolve the patching/configuration syntax from the selected version, not an invented plugin interface.

## E13 — Effect platform Bun

- Source: https://github.com/Effect-TS/effect/tree/main/packages/platform-bun
- Evidence class: source
- Use: Runtime implementations; exact exports must be checked against pinned release.

## E14 — Effect Vite integration

- Source: https://github.com/Effect-TS/effect/tree/main/packages/vite
- Evidence class: source reference
- Use: Candidate integration; availability and APIs require compatibility gate. Do not invent effect/vite imports.

## O01 — OpenCode service conventions

- Source: https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md
- Evidence class: pinned source
- Use: Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.

## O02 — OpenCode v2 instructions

- Source: https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/specs/v2/instructions.md
- Evidence class: pinned source
- Use: Additional architecture guidance; use as design inspiration, not copied implementation.

## B01 — Bun Node compatibility

- Source: https://bun.com/docs/runtime/nodejs-compat
- Evidence class: official documentation
- Use: Bun tracks Node compatibility; compatibility is not completeness and requires our own production path tests.

## B02 — Bun isolated installs

- Source: https://bun.com/docs/pm/isolated-installs
- Evidence class: official documentation
- Use: Isolated dependency layout helps expose phantom dependencies.

## B03 — Bun workspaces/catalogs

- Source: https://bun.com/docs/pm/catalogs
- Evidence class: official documentation
- Use: Shared version catalogs and workspaces; registry packaging must rewrite workspace references correctly.

## B04 — Bun install

- Source: https://bun.com/docs/pm/cli/install
- Evidence class: official documentation
- Use: Lockfile and trusted dependency lifecycle policies.

## B05 — Bun testing

- Source: https://bun.com/docs/test
- Evidence class: official documentation
- Use: Native runtime test runner; not a substitute for @effect/vitest APIs.

## B06 — Bun bundler

- Source: https://bun.com/docs/bundler
- Evidence class: official documentation
- Use: Build targets and executable compilation; does not replace declaration generation/type checking.

## B07 — Bun SQLite

- Source: https://bun.com/docs/runtime/sqlite
- Evidence class: official documentation
- Use: Local runtime-specific database, not a remote durable fleet backend.

## B08 — Bun HTTP server

- Source: https://bun.com/docs/runtime/http/server
- Evidence class: official documentation
- Use: Server/WebSocket APIs belong in Bun adapter, not portable actor core.

## B09 — Bun package publication

- Source: https://bun.com/docs/pm/cli/publish
- Evidence class: official documentation
- Use: Packaging capabilities; trusted publication compatibility must be checked before release.

## B10 — Node release schedule

- Source: https://github.com/nodejs/Release/blob/main/schedule.json
- Evidence class: source
- Use: Select Node 24 LTS support baseline for Sept 2026; Node 26 is additional forward compatibility lane.

## T01 — libSQL versus Turso Database

- Source: https://docs.turso.tech/libsql
- Evidence class: official documentation
- Use: The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.

## T02 — Turso pricing

- Source: https://turso.tech/pricing.md
- Evidence class: official documentation
- Use: Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.

## T03 — Turso JavaScript SDK

- Source: https://docs.turso.tech/sdk/ts/reference
- Evidence class: official documentation
- Use: Inspect transactions, client disposal, protocol, and limitations for selected endpoint.

## T04 — Turso Platform API

- Source: https://docs.turso.tech/api-reference/introduction
- Evidence class: official documentation
- Use: Provisioning/control API is separate from SQL data-plane client.

## T05 — libSQL repository

- Source: https://github.com/tursodatabase/libsql
- Evidence class: source
- Use: Self-hosted engine/server source; not a promise of Cloud feature or economics parity.

## P01 — PlanetScale PostgreSQL pooling

- Source: https://planetscale.com/docs/postgres/connecting/pgbouncer
- Evidence class: official documentation
- Use: Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.

## P02 — PlanetScale PostgreSQL pricing

- Source: https://planetscale.com/docs/postgres/pricing
- Evidence class: official documentation
- Use: Instance, storage, replica and pooling costs need region/configuration-specific pricing.

## P03 — Neki preview

- Source: https://planetscale.com/changelog/neki
- Evidence class: official documentation
- Use: Platform-preview announcement Sept 10 2026. Not selected for V1.

## P04 — PostgreSQL advisory locks

- Source: https://www.postgresql.org/docs/current/explicit-locking.html
- Evidence class: official documentation
- Use: Session-level and transaction-level advisory locks have different lifetime requirements.

## Q01 — SQLite triggers

- Source: https://www.sqlite.org/lang_createtrigger.html
- Evidence class: official documentation
- Use: Transactional row-trigger mechanism; OLD/NEW semantics; test compatibility with target engine.

## Q02 — SQLite transaction model

- Source: https://www.sqlite.org/lang_transaction.html
- Evidence class: official documentation
- Use: Write transaction and locking semantics; supports analysis of local receipts/fence checks.

## Q03 — Electric Shapes

- Source: https://electric-sql.com/docs/guides/shapes
- Evidence class: official documentation
- Use: PostgreSQL data distribution/filtering; not automatic capture from authoritative actor databases.

## Q04 — PowerSync architecture

- Source: https://docs.powersync.com/architecture/overview
- Evidence class: official documentation
- Use: Backend-authoritative sync and client upload model; different authority direction from source actor databases.

## Q05 — Debezium outbox routing

- Source: https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html
- Evidence class: official documentation
- Use: Useful outbox transport pattern; not a ready-made actor-fleet discovery system.

## Q06 — Materialize documentation

- Source: https://materialize.com/docs/
- Evidence class: official documentation
- Use: Incremental views are a substantial specialized query engine; do not quietly implement one inside ProjectionActor.

## C01 — Rivet actor documentation

- Source: https://rivet.dev/docs/actors
- Evidence class: official documentation
- Use: Closest general actor platform; current feature claims must come from docs, not blanket superiority claims.

## C02 — Rivet Effect SDK

- Source: https://rivet.dev/changelog/2026-06-16-introducing-the-effect-sdk/
- Evidence class: official documentation
- Use: Effect integration means Effect-native alone is not differentiation.

## C03 — Rivet Cloud

- Source: https://rivet.dev/cloud/
- Evidence class: official documentation
- Use: Managed cloud and pricing reference; historical prices not assumed current.

## C04 — Cloudflare Durable Objects

- Source: https://developers.cloudflare.com/durable-objects/
- Evidence class: official documentation
- Use: Runtime-owned identity/storage/lifecycle; use for architectural comparison.

## C05 — Durable Objects pricing

- Source: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Evidence class: official documentation
- Use: Requests, duration and storage meters; not directly comparable to our internal messages.

## C06 — Cloudflare D1 limits

- Source: https://developers.cloudflare.com/d1/platform/limits/
- Evidence class: official documentation
- Use: Separate DB hosting candidate with provider-specific API and limits.

## C07 — Orleans persistence

- Source: https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence
- Evidence class: official documentation
- Use: Pluggable grain state, not inherently a private SQL database per entity.

## C08 — Dapr actors

- Source: https://docs.dapr.io/developing-applications/building-blocks/actors/actors-overview
- Evidence class: official documentation
- Use: Virtual identity, activation and shared transactional actor state store.

## C09 — Akka persistence plugins

- Source: https://doc.akka.io/libraries/akka-core/current/persistence-journals.html
- Evidence class: official documentation
- Use: Journal/snapshot persistence architecture; licensing/release policy separate assessment.

## C10 — Temporal durable execution

- Source: https://docs.temporal.io/workflows
- Evidence class: official documentation
- Use: Procedure replay/activity orchestration, not automatic actor-local SQL semantics.

## C11 — Effect Agent

- Source: https://effect-agent.com/
- Evidence class: official documentation
- Use: Future agent competitor; do not implement agent package during actor bootstrapping.

## C12 — mvSQLite

- Source: https://github.com/losfair/mvsqlite
- Evidence class: source reference
- Use: FoundationDB VFS research alternative; operational and maintenance diligence required.

## C13 — Cloud Backed SQLite

- Source: https://sqlite.org/cloudsqlite/doc/trunk/www/index.wiki
- Evidence class: official documentation
- Use: Storage component rather than hosted actor platform; supported object stores and write semantics matter.

## C14 — SlateDB

- Source: https://slatedb.io/docs/
- Evidence class: official documentation
- Use: Object-store KV design; not an arbitrary SQL database replacement.

## C15 — Neon branching

- Source: https://neon.com/docs/introduction/branching
- Evidence class: official documentation
- Use: Coarser tenant/workspace relational isolation option, not a drop-in SQLite actor DB.

## D01 — Railway monorepos

- Source: https://docs.railway.com/guides/monorepo
- Evidence class: official documentation
- Use: Service build/start boundaries and watch paths.

## D02 — Railway private networking

- Source: https://docs.railway.com/guides/private-networking
- Evidence class: official documentation
- Use: Must validate per-replica identity/routing, not use one load-balanced address as runner identity.

## D03 — Railway configuration

- Source: https://docs.railway.com/reference/config-as-code
- Evidence class: official documentation
- Use: Config schema for deployment scaffold.

## D04 — Railway resource pricing

- Source: https://railway.com/pricing
- Evidence class: official documentation
- Use: Meter and plan source; model unverified rates as assumptions.

## D05 — Alchemy

- Source: https://alchemy.run/
- Evidence class: official documentation
- Use: Infrastructure-as-code choice; resolve exact version/provider support before runnable stack.

## D06 — Blacksmith documentation

- Source: https://docs.blacksmith.sh/
- Evidence class: official documentation
- Use: CI runner labels, cache and security model; runner availability is account-dependent.

## D07 — npm trusted publishers

- Source: https://docs.npmjs.com/trusted-publishers/
- Evidence class: official documentation
- Use: Validate supported hosted CI environments; keep release job independent from Blacksmith.

## D08 — Turborepo configuration

- Source: https://turborepo.com/docs/reference/configuration
- Evidence class: official documentation
- Use: Task graph, cached outputs, environment inputs; not a substitute for dependency architecture.

## D09 — Oxlint configuration

- Source: https://oxc.rs/docs/guide/usage/linter/config
- Evidence class: official documentation
- Use: Choose supported config file; use current parser, do not assume arbitrary TypeScript config support.

## D10 — Oxfmt configuration

- Source: https://oxc.rs/docs/guide/usage/formatter/config
- Evidence class: official documentation
- Use: Formatter configuration and ignore rules; root .oxfmtrc.json chosen for simplicity.

## D11 — Vite documentation

- Source: https://vite.dev/guide/
- Evidence class: official documentation
- Use: App development/build tool; not mandatory library compiler.

## D12 — Vitest documentation

- Source: https://vitest.dev/guide/
- Evidence class: official documentation
- Use: @effect/vitest peer compatibility controls major version.

## D13 — Changesets

- Source: https://github.com/changesets/changesets
- Evidence class: source
- Use: Version/changelog workflow, separate from registry authentication.

## D14 — Renovate

- Source: https://docs.renovatebot.com/
- Evidence class: official documentation
- Use: Group coupled compiler/Effect toolchain updates.

## D15 — publint

- Source: https://publint.dev/docs/
- Evidence class: official documentation
- Use: Package manifest and export-map inspection.

## D16 — Are The Types Wrong

- Source: https://github.com/arethetypeswrong/arethetypeswrong.github.io
- Evidence class: source
- Use: Published package type-resolution checks.

## D17 — Trivy SBOM

- Source: https://trivy.dev/docs/latest/guide/supply-chain/attestation/sbom/
- Evidence class: official documentation
- Use: Container/SBOM scanning; not proof of actor correctness.

## D18 — GitHub workflow security

- Source: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Evidence class: official documentation
- Use: Least privilege, immutable action pins, untrusted PR precautions.

## A01 — S3 consistency

- Source: https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
- Evidence class: official documentation
- Use: Object-store consistency does not create atomicity with actor database commits.

## A02 — Cloudflare R2 pricing

- Source: https://developers.cloudflare.com/r2/pricing/
- Evidence class: official documentation
- Use: S3-compatible storage alternative, request/storage billing; ecosystem egress still exists.

## A03 — Tigris docs

- Source: https://www.tigrisdata.com/docs/
- Evidence class: official documentation
- Use: Object storage candidate, regional placement and S3 API compatibility must be tested.

## A04 — Valkey

- Source: https://valkey.io/
- Evidence class: official documentation
- Use: Shared ephemeral cache candidate; loss must not affect correctness.

## A05 — Redis docs

- Source: https://redis.io/docs/latest/
- Evidence class: official documentation
- Use: Compatibility/licensing and hosted service options require current terms.

## A06 — Dragonfly

- Source: https://www.dragonflydb.io/docs/
- Evidence class: official documentation
- Use: Alternative cache; command compatibility and licenses are not assumed identical.

## A07 — Garnet

- Source: https://microsoft.github.io/garnet/
- Evidence class: official documentation
- Use: Alternative RESP implementation; assess only if cache is actual bottleneck.

## A08 — Upstash Redis

- Source: https://upstash.com/docs/redis/overall/getstarted
- Evidence class: official documentation
- Use: Managed cache option; request/connection/latency economics vary.

## A09 — AWS Secrets Manager

- Source: https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html
- Evidence class: official documentation
- Use: Choose control-plane-managed secrets, grants, rotation and audit.

## A10 — Better Auth

- Source: https://www.better-auth.com/docs/installation
- Evidence class: official documentation
- Use: Dashboard authentication candidate; does not implement actor authorization.

## A11 — OpenTelemetry collector

- Source: https://opentelemetry.io/docs/collector/
- Evidence class: official documentation
- Use: OTLP decouples runtime telemetry from vendor; implement cardinality/redaction discipline.

## A12 — Grafana Cloud pricing

- Source: https://grafana.com/pricing/
- Evidence class: official documentation
- Use: Managed observability candidate; cost/cardinality constraints apply.

## A13 — Apache 2.0 license

- Source: https://www.apache.org/licenses/LICENSE-2.0
- Evidence class: official documentation
- Use: Recommended framework license subject to owner/legal approval; do not license owner material without approval.

## A14 — SeaweedFS S3-compatible storage

- Source: https://github.com/seaweedfs/seaweedfs
- Evidence class: source reference
- Use: Self-host candidate to evaluate against S3 conformance tests; not interchangeable merely because an S3 endpoint exists.

## D19 — VitePress

- Source: https://vitepress.dev/guide/getting-started
- Evidence class: official documentation
- Use: Future documentation publishing candidate; initial archive uses a minimal Vite documentation portal.
