# Repository structure

**Responsibility:** where code lives, what each workspace package owns, and the naming rules the tree checker enforces.  
**Authority:** design.  
**Owner role:** runtime architecture.  
**Change policy:** a new top-level directory, workspace package, or subpath entry needs an ADR. Supersedes `package-boundaries.md` (see [ADR 0001](../decisions/0001-repository-structure.md)); [ADR 0063](../decisions/0063-framework-simplification.md) retired the role-folder, leaf-size and reservation rules.

## Tree

```text
apps/                       deployables and the CLI bin; never imported by another package
  api/                      @durable-actors/api        control-plane HTTP; embeds the control-plane actors
  console/                  @durable-actors/console    FoldKit SSR
  docs/                     @durable-actors/docs       static docs site built from docs/ with llms.txt and Markdown copies (ADR 0043)
  e2e/                      @durable-actors/e2e        Playwright browser tests against read-only console fixtures
  edge/                     @durable-actors/edge       hosted ingress: deployment hosts → runners, credentials → signed assertions, proxied sockets, limits
  cli/                      @durable-actors/cli        the `durable` bin: local dev, deploy checks, adoption, operator inspection and repair
packages/
  durable-actors/           @durable-actors/core       the framework; published (other published packages follow ADR 0029)
  react/                    @durable-actors/react      React hooks over @durable-actors/core/client
  create/                   @durable-actors/create     `bun create @durable-actors`: templates/base plus counter and chat overlays
  deployments/              @durable-actors/deployments  Deployment, Runners (singleton), UsageMeter actors — written on the framework
  accounts/                 @durable-actors/accounts   better-auth, organizations, API keys
  billing/                  @durable-actors/billing    Polar
  email/                    @durable-actors/email      Resend
  contracts/                @durable-actors/contracts  control-plane HttpApi shared by api, console, cli
  python-client/            @durable-actors/python-client  generates a Python client from a served OpenAPI document; python/ holds its runtime and tests
  observability/            @durable-actors/observability
  postgres/                 @durable-actors/postgres   control-plane database: schema per domain, migrations/, bin/migrate.ts
  ui/                       @durable-actors/ui         console components; its own package because Babel compiles StyleX before the console imports it
examples/                   runnable examples that double as the end-to-end corpus
  counter/  chat/  coding-agent/  orders/  subscriptions/
infra/                      @durable-actors/infra      Alchemy: alchemy.run.ts, src/railway/, docker/<app>/Dockerfile
tooling/
  oxlint/                   @durable-actors/oxlint     anti-slop rules, directives check, naming, runtime-import and comment rules
  structure/                @durable-actors/structure  tree checker (names, dependency direction, exports, colocated tests) and the exemptions file
  databases/                @durable-actors/databases  disposable Postgres, Neki and PGlite for tests
  benchmarks/               @durable-actors/benchmarks  `bun run bench` performance harness (ADR 0018)
  doc-checks/               @durable-actors/doc-checks  typechecks doc examples and checks repository links (ADR 0061)
benchmarks/                 committed benchmark results and how to read them; data only, no code
docs/  research/  .github/src/
```

Dependency direction: `apps → packages → nothing app-ward`. `packages/durable-actors` imports no other workspace package. Control-plane packages depend on the framework through `workspace:*`; the control plane is the first customer.

## The framework package

`@durable-actors/core` ships one distribution with four subpath entries: `.` (`src/index.ts`), `./client`, `./runtime` and `./testing`. The root and `client/` are browser-safe declarations, tags, handles and the Promise client; `runtime/` and `testing/` are the only folders that may import `effect/unstable/sql`, `@effect/sql-pg` or `effect/unstable/cluster`, which `no-runtime-import-outside-runtime` enforces. `X.toLayer` and `X.get` reach the runtime only through the `Actors` tag. Folders under `src/` are named for the responsibility they own; the source tree, not this page, lists them.

## Naming contract

- Package name is `@durable-actors/<directory basename>`, except the framework in `packages/durable-actors`, which is `@durable-actors/core` ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md)). A name says what the package owns, never a layer.
- Folders are kebab-case nouns with one responsibility. Forbidden: `core shared common utils helpers lib misc domain types internal`. Role-plural folders (`commands/ events/ queries/ workflows/ effects/ providers/`) are allowed inside a feature with two or more files.
- Files are kebab-case and named for an operation (`create.ts`) or a role (`contract.ts layer.ts queries.ts handler.ts repository.ts schema.ts errors.ts state.ts config.ts client.ts`). Never `<parent>-<x>.ts`, never `<x>-service.ts`.
- A small actor is one module named for it, such as `counter.ts`, holding its `Actor.make` definition and its layers. Split it into an `<actor>/` folder with role files — `contract.ts` (the definition), `layer.ts` (`X.toLayer`), `queries.ts` (`X.toQueryLayer`), `jobs.ts` (`X.toJobLayer`), `workflows/` — when a responsibility needs its own module: a browser client or another process imports the definition without the handlers, an executor layer deploys separately, or one file no longer reads as one responsibility. Do not create empty role files.
- `index.ts` exists only as a package or subpath entry and names real files; no `./*` wildcard exports.
- Unit and integration tests are `x.test.ts` beside the corresponding `src/x.ts`, one test file per source file. Browser E2E specs alone live outside source under `apps/e2e/` as `*.e2e.ts`.
- Every deviation is one entry in `tooling/structure/src/exemptions.ts` with a reason; an entry that matches nothing fails the check.

Two checks implement this specification, each owning different rules. Per-file oxlint rules in `tooling/oxlint` check file and folder names (`filename-kebab-case`, `no-parent-echo-in-filename`, `no-role-suffix-filename`, `no-generic-directory-segment`) and the runtime import boundary (`no-runtime-import-outside-runtime`). The tree checker in `tooling/structure` (`bun run lint:structure`) reads every `package.json` and owns package names, dependency direction, explicit `exports` with no wildcards, `index.ts` placement, and colocated tests. Module size is not checked: split a module when its responsibilities diverge, not to satisfy a count.

## Ways to run, mapped to the tree

- **Embedded:** an application provides `Actors.layer` from `@durable-actors/core/runtime` and calls actors as Effects. `apps/api` runs this way.
- **Served:** `Actor.serve` in its own process; the `docker/` images and a customer's BYO runner are this shape. There is no `apps/runner`: a managed runner is the customer's served container started by a `Deployment` actor effect.
- **Hosted:** the same layer on our runners behind `apps/edge`, with Neki as the database.

## Implemented, planned and published

A directory exists when it holds code; there are no `.gitkeep` reservations for planned work. A planned package, command or folder is named in its design document until its first real module and test land. Do not add placeholder passing tests.

`apps/cli` ships the `durable` bin as a working local development, deploy-check, adoption and operator tool: `dev`, `workflows check`, `payloads`, `adopt`, `fleet`, `defects`, `inspect`, `export`, `receipts`, `dead-letters`, `subscriptions` and `tenants` ([CLI reference](../api/06-cli.md)). Hosted `login`, `deploy` and `migrate` commands are not implemented and have no reserved directories ([ADR 0063](../decisions/0063-framework-simplification.md)).

`@durable-actors/core` is the one published package today. The workspace resolves its entries to TypeScript sources; `bun run --cwd packages/durable-actors build` emits `dist/`, and `publishConfig` points the tarball's `exports` and `types` there. `.github/src/pack.ts` stages and checks the tarball in CI, and `.github/workflows/release.yml` publishes it on a `v<version>` tag ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md); the first publish is CR.1b, [#99](https://github.com/Rika-Labs/durable-actors/issues/99)). `@durable-actors/create` stays private until that release; its build resolves the scaffold's pinned versions from the workspace catalog, and `.github/src/release/quickstart.ts` installs both tarballs into each generated app.
