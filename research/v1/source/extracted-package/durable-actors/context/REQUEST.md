I am preparing to execute on a new company/framework called **Durable Actors**.

Your job is to perform an exhaustive, adversarial, implementation-oriented research pass across the entire technical stack, choose the remaining undecided technologies, document every important decision, and generate a ZIP containing the complete non-implementation repository skeleton.

Do not implement the Durable Actors runtime itself yet.

The result should be detailed enough that another strong engineer could clone the generated repository, read the documents, and immediately begin implementation without needing to rediscover architectural decisions.

# PRODUCT

Durable Actors is an opinionated, Effect-native virtual actor framework for TypeScript.

The core mental model is:

- one actor = one durable domain entity
- stable actor identity
- serialized mutations per actor
- actors communicate through typed protocols
- actors activate/passivate automatically
- actor compute can move between runners
- stateless work remains normal Effect code
- HTTP / CLI / WebSocket / SSE are transports over actor protocols
- domains communicate through ActorRefs rather than importing each other's repos/services

Each actor should eventually have access to opinionated primitives such as:

- `Database`
- `BlobStore`
- `Actors`
- `Scheduler`
- `Activities`
- `Events`
- `Broadcast`
- `Cache`
- `Secrets`
- Effect `Clock`
- Effect tracing/metrics

Do not blindly assume every proposed primitive belongs in core. Adversarially evaluate each one.

# CURRENT ARCHITECTURAL DIRECTION

Assume these are strong preferences, but challenge them if research reveals material problems.

## Language/runtime

- TypeScript
- Effect v4
- Bun as the primary runtime/toolchain
- Node compatibility is required
- research every Bun capability we should exploit:
  - package manager
  - workspaces
  - scripts
  - test runner
  - bundler
  - shell
  - SQLite
  - HTTP/server APIs
  - WebSockets
  - workers
  - file APIs
  - transpilation
  - package publishing
  - Node compatibility
  - runtime differences
  - performance
  - production maturity
- determine where we should use native Bun APIs and where using them would damage Node portability

## Actor runtime

- Effect Cluster as the likely distributed substrate
- use Effect primitives wherever possible instead of inventing replacements
- investigate deeply:
  - Entity
  - EntityResource
  - EntityProxy
  - MessageStorage
  - RunnerStorage
  - Sharding
  - shard ownership
  - leases
  - passivation
  - delayed delivery
  - retries
  - request/reply
  - deduplication
  - Singleton
  - ClusterCron
  - ClusterWorkflowEngine
  - TestRunner
  - HTTP and socket runners
- identify exactly what Effect Cluster guarantees and what Durable Actors must add
- investigate known correctness/failure concerns, especially stale ownership and fencing
- do not assume exactly-once semantics

## Actor-local storage

Current direction:

- every actor receives a private relational database
- `const db = yield* Database`
- Turso/libSQL is the current preferred hosted backend
- Effect SQL should be the primary DB API
- Drizzle should be optional, not foundational
- each actor can have arbitrary tables/indexes/migrations
- actor-private DB is authoritative for that actor's domain data

Research:

- Turso architecture, limits, pricing, provisioning latency, DB count limits, write/read economics, libSQL compatibility, PITR/backups, regions, replication, self-hosting
- alternatives including niche ones
- Layerbase
- mvSQLite/FoundationDB
- SQLite Cloud Backed SQLite
- libSQL self-hosting
- D1
- Neon
- SlateDB
- any newer/more suitable alternatives
- determine if Turso is still the right V1 choice

## Cluster/control database

Current direction:

- PlanetScale Postgres
- potentially Neki later
- used for Effect Cluster coordination/runtime metadata where appropriate
- customer projection databases should not be hosted by us by default

Research:

- suitability for Effect Cluster
- transaction/lock semantics
- Effect SQL compatibility
- connection behavior
- scaling
- Neki suitability and shard key strategy
- whether another Postgres provider would materially improve the system

## Projections

This is a major proposed framework feature.

Example:

```ts
const todos = Database.table("todos", {
  id: Schema.String,
  projectId: Schema.String,
  text: Schema.String,
  done: Schema.Boolean,
}).pipe(
  Database.projected(),
)

```

Desired semantics:

actor-local private SQLite/libSQL
→ automatic CDC/outbox
→ customer-owned projection database
→ arbitrary global SQL/joins

Potentially:

```ts
const ProjectTodos = ProjectionActor.make("ProjectTodos", {
  source: todos,
  key: todo => todo.projectId,
  target: projectTodos,
})

```

which incrementally materializes a subset/derived view back into that actor's private SQLite DB.

Research this deeply.

Determine:

- feasibility
- implementation strategies
- SQLite triggers vs framework interception vs WAL/CDC
- transactional outbox design
- ordering
- idempotency
- deletes
- updates
- projection-key changes
- retries
- replay
- rebuilding a projection
- schema evolution
- customer DB migrations
- multi-source projections
- projection actors
- index specialization
- aggregation
- eventual consistency guarantees
- failure modes
- backpressure
- how projections interact with Effect Stream/EventLog
- closest existing systems:
  - PowerSync
  - ElectricSQL
  - Materialize
  - Debezium
  - Kafka Connect
  - Rivet
  - Durable Objects
  - any niche projects

Be adversarial about whether this should exist in V1.

## Durable work

Research whether to directly use:

- Effect Workflow
- Activity
- DurableClock
- DurableDeferred
- DurableQueue
- ClusterWorkflowEngine

Determine what Durable Actors should expose versus simply reusing Effect APIs directly.

Desired actor-level idea:

```ts
const activities = yield* Activities
const scheduler = yield* Scheduler

```

But challenge whether wrappers are useful or unnecessary.

## Messaging/protocols

Research deeply whether actor protocols should build directly on:

- Effect RPC
- Rpc
- RpcGroup
- Schema
- Effect Cluster Entity protocols

Current desired API direction:

```ts
const Counter = Actor.make("Counter", {
  state: CounterState,
  protocol: CounterProtocol,
})

const CounterLive = Counter.toLayer({
  Increment: ...,
  Get: ...,
})

```

And:

```ts
const actor = yield* actors.get(Counter, "123")

yield* actor.send(...)
const result = yield* actor.request(...)

```

Evaluate multiple API/interface designs.

Prefer:

- immutable definitions
- implementation separated into Layers
- idiomatic Effect
- minimal generic complexity
- strong inference
- no huge config objects
- no "pipe everything because Effect uses pipe"
- no custom dependency injection system

## Realtime

Research how we should build:

- `Broadcast`
- live actor events
- replayable actor events
- SSE
- WebSockets
- reconnect cursors
- event sequencing
- presence
- many clients connected to one actor

Use existing Effect primitives wherever possible:

- Stream
- PubSub
- SubscriptionRef
- Socket
- SocketServer
- SSE encoding
- HttpApi

Distinguish live ephemeral broadcast from durable event history.

## Blob storage

Current conceptual API:

```ts
const blobs = yield* BlobStore

```

Actor should receive an automatically actor-scoped namespace.

Example physical key:

```text
actors/Order/order_123/invoice.pdf

```

Research and choose:

- S3
- Cloudflare R2
- Tigris
- MinIO/self-hosted
- Railway volumes/object storage if relevant
- other S3-compatible providers

Choose hosted and self-hosted defaults.

Do not expose S3 as the actor API.

## Cache

Current conceptual API:

```ts
const cache = yield* Cache

```

Shared infrastructure, automatically actor-namespaced.

Research:

- Redis
- Valkey
- Dragonfly
- Garnet
- Upstash
- Railway Redis/Valkey options
- Effect persistence/cache primitives

Choose the default backend.

Do not provision one Redis instance per actor.

## Secrets

Current conceptual API:

```ts
const secrets = yield* Secrets

```

Research:

- hosted secret storage
- encryption/KMS
- actor/app/tenant scoping
- rotation
- audit trails
- self-hosted Vault/Kubernetes/env adapters
- Railway variables
- Alchemy integrations
- AWS/GCP/KMS options

Determine whether `Secrets` belongs in core.

## Event history

Investigate Effect EventLog:

- Event
- EventGroup
- EventJournal
- EventLog
- SqlEventJournal
- remote event log server
- encryption support

Determine whether Durable Actors should use EventLog internally, expose a wrapper, or simply integrate with it.

## HTTP/API

Use Effect HttpApi unless research strongly contradicts it.

Desired principle:

Actors speak domain protocols.
HTTP maps domain results/errors into HTTP semantics.

Research:

- HttpApi
- HttpApiBuilder
- clients
- OpenAPI
- Swagger/Scalar
- security middleware
- SSE
- typed errors
- deployment through Bun/Railway

## CLI

Use Effect CLI unless research strongly contradicts it.

CLI should be another transport over actor protocols.

## Observability

Research and decide:

- OpenTelemetry
- OTLP
- Prometheus
- tracing vendor
- logs vendor
- metrics vendor
- error reporting
- local dev observability

Every actor operation should automatically include:

- tenant
- actor type
- actor id
- message id
- causation id
- correlation id
- runner
- shard
- activity id where applicable

Evaluate:

- Grafana Cloud
- Honeycomb
- Better Stack
- Sentry
- Axiom
- Datadog
- self-host options

Choose defaults while keeping OTLP portability.

# MONOREPO / ENGINEERING TOOLING

Current preferences:

- Bun
- Node compatibility
- Effect v4
- TypeScript
- tsgo / TypeScript 7 where appropriate
- every Effect/tsgo lint rule enabled as error
- Oxlint
- Oxformat
- Turborepo
- Blacksmith GitHub runners
- GitHub
- Railway deployments
- Alchemy.run infrastructure
- Vite
- Effect/Vite integration
- tests mirror source tree
- package-oriented monorepo

Research each one deeply instead of merely accepting it.

For every chosen technology evaluate:

1. purpose
2. alternatives
3. why chosen
4. maturity
5. performance
6. developer experience
7. Effect integration
8. Bun integration
9. Node compatibility
10. CI behavior
11. local development behavior
12. production behavior
13. maintenance risk
14. licensing
15. pricing
16. lock-in
17. migration path
18. known issues
19. operational burden
20. security implications

# OPENCODE STYLE

Research the current OpenCode repository and Effect-related conventions carefully.

We particularly like:

- small files
- one Effect service/module per file
- explicit interfaces
- Context.Service
- `layer` / `defaultLayer`
- public functions wrapped with named `Effect.fn`
- private helpers as ordinary top-level functions
- strong package boundaries
- avoiding raw platform APIs where Effect provides a capability
- domain folders containing protocol/service/repo/schema/actor style separation where appropriate

Do not cargo-cult OpenCode. Identify which conventions are genuinely good for a framework library and which are application-specific.

# TEST STRUCTURE

We strongly prefer:

```text
src/foo/bar.ts
test/foo/bar.test.ts

```

Tests should mirror the `src` tree.

Research and choose:

- Bun test vs Vitest vs @effect/vitest
- property testing
- integration testing
- Effect TestClock
- cluster testing
- database testing
- chaos/fault injection
- snapshot tests
- protocol compatibility tests
- API type tests
- package export tests
- performance benchmarks

Choose a concrete strategy.

# REPOSITORY

Propose the complete monorepo package structure.

Likely starting point:

```text
apps/
packages/
examples/
docs/
infra/
scripts/

```

Evaluate likely packages such as:

```text
@durable-actors/core
@durable-actors/cluster
@durable-actors/turso
@durable-actors/projections
@durable-actors/http
@durable-actors/cli
@durable-actors/testing
@durable-actors/cloud

```

Do not create packages merely because they sound nice.

Determine the minimum healthy package graph.

No circular dependencies.

Clearly document dependency direction.

# BUN

Go especially deep on Bun.

We have decided Bun should be the primary runtime/toolchain, while Node compatibility remains a first-class requirement.

Determine exactly what to use Bun for:

- runtime
- package manager
- workspaces/catalogs
- test runner
- shell scripts
- subprocess APIs
- build/transpile
- bundling
- macros/plugins if relevant
- SQLite where useful
- HTTP
- WebSocket
- file APIs
- watch mode
- env loading
- executable compilation if useful
- Docker images
- Node API compatibility

Explicitly identify:

- Bun-only APIs we should avoid in framework packages
- Bun-only APIs acceptable in apps/tooling
- Node compatibility test matrix
- package export conditions
- CI matrix
- differences in streams, sockets, process handling, crypto, fetch, workers, module resolution, package resolution, native addons

Create a formal **BUN\_NODE\_COMPATIBILITY.md**.

# CI/CD

Research and design:

GitHub
→ Blacksmith
→ install/cache
→ Oxformat check
→ Oxlint type-aware + Effect tsgo rules
→ typecheck
→ unit tests
→ integration tests
→ package builds
→ package export/API validation
→ examples
→ Docker
→ Railway preview deploy where appropriate

Also:

- nightly benchmarks
- nightly chaos tests
- dependency vulnerability scanning
- container scanning
- npm provenance
- SBOM
- GitHub Actions pinning
- release workflow

# RELEASE/PUBLISHING

Choose and configure:

- package manager
- npm publishing
- Changesets or alternative
- semantic versioning
- prereleases
- RC channels
- package provenance
- GitHub releases
- changelogs
- compatibility policy
- unstable APIs
- release branches or trunk-based releases

# INFRASTRUCTURE

Current direction:

- Railway for application deployment
- Alchemy.run for infrastructure
- PlanetScale Postgres
- Turso
- S3-compatible BlobStore
- Redis/Valkey-like cache
- Blacksmith
- GitHub

Research how these should actually fit together.

Define:

- local
- CI
- preview
- staging
- production

Environments.

Determine what belongs to Railway versus Alchemy.

Investigate whether Railway should also provide any backing services or whether external providers are preferable.

# LOCAL DEVELOPMENT

Design an excellent local developer experience.

Goal:

```bash
bun install
bun dev

```

should get someone productive.

Determine:

- local actor runner
- local Effect Cluster mode
- local SQLite/libSQL actor DBs
- local Postgres
- local BlobStore
- local cache
- local projection sink
- test fixtures
- local dashboard/devtools
- Docker dependencies
- whether Docker should even be required

# DOCUMENTATION OUTPUT

Produce standalone Markdown documents including at minimum:

```text
README.md

docs/
  VISION.md
  PRODUCT.md
  PRINCIPLES.md
  PROGRAMMING_MODEL.md
  ARCHITECTURE.md
  SYSTEM_DIAGRAMS.md
  ACTOR_MODEL.md
  ACTOR_LIFECYCLE.md
  ACTOR_PROTOCOLS.md
  DURABILITY.md
  CONSISTENCY.md
  DATABASE.md
  PROJECTIONS.md
  PROJECTION_ACTORS.md
  ACTIVITIES.md
  SCHEDULING.md
  EVENTS.md
  REALTIME.md
  BLOB_STORAGE.md
  CACHE.md
  SECRETS.md
  SECURITY.md
  MULTITENANCY.md
  HTTP.md
  CLI.md
  OBSERVABILITY.md
  EFFECT_INTEGRATION.md
  EFFECT_CLUSTER.md
  EFFECT_WORKFLOW.md
  EFFECT_SQL.md
  TURSO.md
  POSTGRES.md
  BUN.md
  BUN_NODE_COMPATIBILITY.md
  MONOREPO.md
  PACKAGE_BOUNDARIES.md
  CODE_STYLE.md
  EFFECT_STYLE.md
  TESTING.md
  CHAOS_TESTING.md
  BENCHMARKS.md
  LOCAL_DEVELOPMENT.md
  CI_CD.md
  DEPLOYMENT.md
  INFRASTRUCTURE.md
  SELF_HOSTING.md
  CLOUD_ARCHITECTURE.md
  RELEASES.md
  VERSIONING.md
  DEPENDENCY_POLICY.md
  SECURITY_THREAT_MODEL.md
  COST_MODEL.md
  PRICING.md
  COMPETITIVE_ANALYSIS.md
  RISKS.md
  ROADMAP.md
  V1_SCOPE.md
  NON_GOALS.md
  OPEN_QUESTIONS.md
  CONTRIBUTING.md
  CONTRIBUTING_ARCHITECTURE.md

```

# ADRS

Create detailed architecture decision records such as:

```text
docs/adr/
  001-effect-v4.md
  002-bun-primary-runtime.md
  003-node-compatibility.md
  004-effect-cluster.md
  005-private-db-per-actor.md
  006-turso-libsql.md
  007-effect-sql.md
  008-planetscale-postgres.md
  009-serialized-actor-mutations.md
  010-projection-model.md
  011-customer-owned-projection-db.md
  012-effect-workflow.md
  013-effect-rpc.md
  014-effect-httpapi.md
  015-effect-cli.md
  016-opentelemetry.md
  017-blob-storage.md
  018-cache-backend.md
  019-secrets-model.md
  020-monorepo-tooling.md

```

Add more where research warrants them.

Every ADR should contain:

- status
- context
- decision
- alternatives considered
- consequences
- risks
- revisit triggers
- relevant sources

# CODEBASE SKELETON

Create the actual repository skeleton.

No Durable Actors runtime implementation yet.

It SHOULD include:

- workspace package structure
- package.json files
- Bun workspace configuration
- Turborepo config
- TypeScript/tsgo configs
- Oxlint config
- Oxformat config
- Effect lint rules at error level
- Vite configs where appropriate
- test configs
- basic empty Effect service/module skeletons where helpful
- package export maps
- `src` folders
- mirrored `test` folders
- placeholder README files
- `.gitignore`
- `.editorconfig` if useful
- GitHub Actions using Blacksmith
- release workflow
- Renovate config if selected
- Changesets config if selected
- Railway configs
- Alchemy.run skeleton
- Docker/dev container files only if justified
- local development scripts
- environment variable examples
- license placeholder/recommendation
- security policy
- CODEOWNERS if useful

Do NOT implement actor runtime behavior yet.

Do not fake implementations with misleading placeholder logic.

Interfaces/types may be stubbed only where doing so helps establish package boundaries.

Prefer comments/TODOs over fake code.

# RESEARCH METHOD

Use:

- current official documentation
- GitHub source
- issue trackers
- changelogs
- release notes
- benchmarks
- engineering blogs
- pricing pages
- real-world discussions where useful

Prefer primary sources.

Research current state as of today's date.

Do not trust earlier assumptions merely because I supplied them.

Adversarially review every chosen technology.

For each major choice include:

- why this is right
- why this may be wrong
- what would cause us to switch
- migration/escape path

# COMPETITIVE SYSTEMS

Research and compare:

- Rivet Actors
- Cloudflare Durable Objects
- Cloudflare Agents
- Microsoft Orleans
- Dapr Actors
- Akka
- Temporal
- Effect Agent
- Effect Cluster directly
- OpenCode architectural patterns
- Turso
- ElectricSQL
- PowerSync
- any relevant newer/niche actor, durable execution, state sync, or database-per-entity systems

Focus on concrete architectural differences.

# COMPANY/PRODUCT

Also produce:

- OSS strategy
- licensing recommendation
- cloud product boundary
- self-hosted boundary
- pricing hypotheses
- cost model
- Turso economics
- PlanetScale economics
- Railway economics
- blob/cache costs
- projected gross margins
- enterprise/private runner options
- what we host
- what customers provide
- future managed projection DB possibility
- positioning
- GTM wedge
- target users
- V1 launch scope
- milestones
- initial hiring needs
- primary execution risks

Clearly distinguish researched facts from estimates.

# FINAL OUTPUT

Create a ZIP file containing:

1. all research and design documents
2. ADRs
3. complete monorepo skeleton
4. configs/tooling setup
5. CI/CD skeleton
6. deployment/infra skeleton
7. package README files
8. examples directory skeleton
9. architecture diagrams in Mermaid/text
10. a root `START_HERE.md` explaining exactly how to navigate the repository and begin implementation

Do not merely describe what the ZIP would contain.

Actually generate it.

Before finishing:

- ensure files are internally consistent
- ensure naming is consistent
- ensure dependency directions match the docs
- ensure config choices match ADRs
- ensure package exports are valid
- ensure the skeleton does not accidentally contain runtime implementation
- run format/lint/config validation where possible
- inspect the final directory tree
- include a `RESEARCH_SOURCES.md` with source links grouped by topic
- include a `DECISIONS_SUMMARY.md` containing every settled decision and every unresolved question

Be exhaustive.

Depth is more important than speed.

The output should be an execution package, not a brainstorm.