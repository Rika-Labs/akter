# Repository structure

**Responsibility:** where code lives, what each workspace package owns, and the naming rules the tree checker enforces.  
**Authority:** design.  
**Owner role:** runtime architecture.  
**Change policy:** a new top-level directory, workspace package, or subpath entry needs an ADR. Supersedes `package-boundaries.md` (see [ADR 0001](../decisions/0001-repository-structure.md)).

## Tree

```text
apps/                       deployables and the CLI bin; never imported by another package
  api/                      @durable-actors/api        control-plane HTTP; embeds the control-plane actors
  console/                  @durable-actors/console    FoldKit SSR
  docs/                     @durable-actors/docs       static docs site built from docs/ with llms.txt and Markdown copies (ADR 0042)
  e2e/                      @durable-actors/e2e        Playwright browser tests against read-only console fixtures
  edge/                     @durable-actors/edge       hosted ingress: deployment hosts → runners, API key → Principal, parked sockets, limits
  cli/                      @durable-actors/cli        `durable login | dev | deploy | migrate | dead-letters`
packages/
  durable-actors/           @durable-actors/core       the framework; published (other published packages follow ADR 0029)
  deployments/              @durable-actors/deployments  Deployment, Runners (singleton), UsageMeter actors — written on the framework
  accounts/                 @durable-actors/accounts   better-auth, organizations, API keys
  billing/                  @durable-actors/billing    Polar
  email/                    @durable-actors/email      Resend
  contracts/                @durable-actors/contracts  control-plane HttpApi shared by api, console, cli
  observability/            @durable-actors/observability
  postgres/                 @durable-actors/postgres   control-plane database: schema per domain, migrations/, bin/migrate.ts
  ui/                       @durable-actors/ui         exempt: StyleX compile unit (see tooling/structure/src/exemptions.ts)
examples/                   runnable examples that double as the end-to-end corpus
  counter/  chat/  coding-agent/
infra/                      @durable-actors/infra      Alchemy: alchemy.run.ts, src/railway/, docker/<app>/Dockerfile
tooling/
  oxlint/                   @durable-actors/oxlint     anti-slop rules, directives check, per-file structure rules
  structure/                @durable-actors/structure  tree checker and the exemptions file
  databases/                @durable-actors/databases  disposable Postgres, Neki and PGlite for tests
  benchmarks/               @durable-actors/benchmarks  `bun run bench` performance harness (ADR 0018)
benchmarks/                 committed benchmark results and how to read them; data only, no code
docs/  research/  .github/src/
```

Dependency direction: `apps → packages → nothing app-ward`. `packages/durable-actors` imports no other workspace package. Control-plane packages depend on the framework through `workspace:*`; the control plane is the first customer.

## The framework package

`@durable-actors/core` ships one distribution with four subpath entries. The root and `client/` are browser-safe contracts, tags and handles; `runtime/` and `testing/` are the only folders that may import `effect/unstable/sql`, `@effect/sql-pg` or `effect/unstable/cluster`. `X.toLayer` and `X.get` reach the runtime only through the `Actors` tag.

```text
packages/durable-actors/src/
  index.ts        "."          Actor, policies, errors, identity, Actors, Actor.serve, Actor.auth
  identity/       TenantId, DeploymentId, ActorRef, Principal (module-augmented), Caller, CurrentCaller, CommandId
  errors/         ActorError + reasons; boundary errors (Unauthorized, InvalidInput, TransportError)
  members/        command, query, stream, connection, workflow, blob, migration; the Members bag types
  policies/       activation (Hibernate, Lifecycle, Connections), delivery (Mailbox, Delivery, Commands, Receipts, Defects),
                  retention (Events, State), schedule (Cron), effects, the Policy bag
  actor/          Actor.make, ActorDefinition, MintedId / SingletonId, the Actor namespace
  state/          keyed state and blob handles
  tables/         OwnedTable, ScopedRead, table(), the Database tag (Drizzle types only)
  handles/        Handle, WorkflowHandle, Connection, ActorEvent, intents, ClientOptions, the Actors tag
  contexts/       command, query, stream, connection, wake, run, effect, workflow; InsideTurn guard
  activation/     HandlersFor, context services, toLayer / toQueryLayer / toEffectLayer (still DB-free)
  serve/          HttpApi router, Auth, OpenAPI, ServeOptions, Actor.serve
  client/         "./client"   Promise client, transport, async iterators, error decoding
  runtime/        "./runtime"  Actors.layer, RuntimeControl
    topology/     single, http, fromConfig, sharding glue
    database/     PgClient + Drizzle layer, config, migrations/, neki/ (relay, transaction mode)
    turn/         execute, fence, receipt, state (decode + migration chain), events, outbox, intents, timers, transaction, report
    entity/       mailbox, activation, hibernate, lease
    workflows/    compile to Effect Workflow, activities, durable clock, deferreds
    connections/  registry, park, presence
    effects/      executor, retry, dead-letter
    events/       append, replay, retention
    cron/         scheduler
    serialization/ codec, registry
  testing/        "./testing"  ActorTest, BoundActor, turns, effects, faults, cluster, clock, workflows, server, scripts, pglite
    conformance/  describe, postgres, neki, pglite, crash/ (turns/, delivery/: real SIGKILL fixtures and cases)
```

## Naming contract

- Package name is `@durable-actors/<directory basename>`, except the framework in `packages/durable-actors`, which is `@durable-actors/core` ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md)). A name says what the package owns, never a layer.
- Folders are kebab-case nouns with one responsibility. Forbidden: `core shared common utils helpers lib misc domain types internal`. Role-plural folders (`commands/ events/ queries/ workflows/ effects/ providers/`) are allowed inside a feature with two or more files.
- Files are kebab-case and named for an operation (`create.ts`) or a role (`contract.ts layer.ts queries.ts handler.ts repository.ts schema.ts errors.ts state.ts config.ts client.ts`). Never `<parent>-<x>.ts`, never `<x>-service.ts`.
- An actor definition is a role folder: `<actor>/contract.ts` (the `Actor.make` definition), `<actor>/layer.ts` (`X.toLayer`), `<actor>/queries.ts` (`X.toQueryLayer`), `<actor>/effects.ts` (`X.toEffectLayer`), with `workflows/` beside them when they exist.
- `index.ts` exists only as a package or subpath entry and names real files; no `./*` wildcard exports.
- Unit and integration tests are `x.test.ts` beside the corresponding `src/x.ts`, one test file per source file. Browser E2E specs alone live outside source under `apps/e2e/` as `*.e2e.ts`.
- A leaf directory warns at 12 authored modules.
- Every deviation is one entry in `tooling/structure/src/exemptions.ts` with a reason; an entry that matches nothing fails the check.

Two lint layers implement this specification: per-file oxlint rules in `tooling/oxlint` (`filename-kebab-case`, `no-parent-echo-in-filename`, `no-role-suffix-filename`, `no-generic-directory-segment`, `no-barrel-index`, `no-runtime-import-outside-runtime`) and the tree checker in `tooling/structure`. Both were added in `85adfb2`; their presence does not imply that the actor runtime is implemented. The rules above remain the contract for their coverage.

## Ways to run, mapped to the tree

- **Embedded:** an application provides `Actors.layer` from `@durable-actors/core/runtime` and calls actors as Effects. `apps/api` runs this way.
- **Served:** `Actor.serve` in its own process; the `docker/` images and a customer's BYO runner are this shape. There is no `apps/runner`: a managed runner is the customer's served container started by a `Deployment` actor effect.
- **Hosted:** the same layer on our runners behind `apps/edge`, with Neki as the database.

## Scaffolds versus implemented features

Directories that hold only `.gitkeep` reserve ownership. Entry files that `export {}` are placeholders, not APIs. Add the test task with the first real behavior test; do not add placeholder passing tests. The CLI has no `bin` until `durable login` exists. `@durable-actors/core` is the one published package today. The workspace resolves its entries to TypeScript sources; `bun run --cwd packages/durable-actors build` emits `dist/`, and `publishConfig` points the tarball's `exports` and `types` there. `.github/src/pack.ts` stages and checks the tarball in CI, and `.github/workflows/release.yml` publishes it on a `v<version>` tag ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md); the first publish is CR.1b, [#99](https://github.com/Rika-Labs/durable-actors/issues/99)).
