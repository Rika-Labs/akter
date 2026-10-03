# Repository structure

**Responsibility:** where code lives, what each workspace package owns, and the naming rules the tree checker enforces.  
**Authority:** design.  
**Owner role:** runtime architecture.  
**Change policy:** a new top-level directory, workspace package, or subpath entry needs an ADR. Supersedes `package-boundaries.md` (see [ADR 0001](../decisions/0001-repository-structure.md)); [ADR 0063](../decisions/0063-framework-simplification.md) retired the role-folder, leaf-size and reservation rules.

## Tree

```text
apps/                       deployables and the CLI bin; never imported by another package
  console/                  @akter/console    the hosted product console: FoldKit client app on Vite (ADR 0064)
  e2e/                      @akter/e2e        Playwright browser tests against read-only console fixtures
  edge/                     @akter/edge       hosted ingress: deployment hosts → runners, credentials → signed assertions, proxied sockets, limits
  site/                     @akter/site       the public website: Astro, static output, StyleX (ADR 0064)
  cli/                      @akter/cli        the `durable` bin: local dev, deploy checks, adoption, operator inspection and repair
packages/
  akter/           @rikalabs/akter       the framework; published (other published packages follow ADR 0029)
  react/                    @akter/react      React hooks over @rikalabs/akter/client
  deployments/              @akter/deployments  Deployment, Runners (singleton), UsageMeter actors — written on the framework
  python-client/            @akter/python-client  generates a Python client from a served OpenAPI document; python/ holds its runtime and tests
  postgres/                 @akter/postgres   control-plane database: schema per domain, migrations/, bin/migrate.ts
  flags/                    @akter/flags      control-plane flag declarations, evaluation and override stores; browser entry excludes SQL (ADR 0073)
  ui/                       @akter/ui         the shared design system: StyleX tokens, FoldKit components, charts, brand geometry (ADR 0064)
tooling/
  oxlint/                   @akter/oxlint     anti-slop rules, directives check, naming, runtime-import and comment rules
  structure/                @akter/structure  tree checker (names, dependency direction, exports, colocated tests) and the exemptions file
BENCHMARKS.md               consolidated performance and recovery report
docs/  research/  .github/src/
```

Dependency direction: `apps → packages → nothing app-ward`. `packages/akter` imports no other workspace package. Control-plane packages depend on the framework through `workspace:*`; the control plane is the first customer.

## The framework package

`@rikalabs/akter` ships one distribution with four subpath entries: `.` (`src/index.ts`), `./client`, `./runtime` and `./testing`. The root and `client/` are browser-safe declarations, tags, handles and the Promise client; `runtime/` and `testing/` are the only folders that may import `effect/sql`, `@effect/sql-pg` or `effect/cluster`, which `no-runtime-import-outside-runtime` enforces. `X.toLayer` and `X.get` reach the runtime only through the `Actors` tag. Folders under `src/` are named for the responsibility they own; the source tree, not this page, lists them.

## Naming contract

- Package name is `@akter/<directory basename>`, except the framework in `packages/akter`, which is `@rikalabs/akter` ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md)). A name says what the package owns, never a layer.
- Folders are kebab-case nouns with one responsibility. Forbidden: `core shared common utils helpers lib misc domain types internal`. Role-plural folders (`commands/ events/ queries/ workflows/ jobs/ providers/`) are allowed inside a feature with two or more files.
- Files are kebab-case and named for an operation (`create.ts`) or a role (`contract.ts layer.ts queries.ts handler.ts repository.ts schema.ts errors.ts state.ts config.ts client.ts`). Never `<parent>-<x>.ts`, never `<x>-service.ts`.
- A small actor is one module named for it, such as `counter.ts`, holding its `Actor.make` definition and its layers. Split it into an `<actor>/` folder with role files — `contract.ts` (the definition), `layer.ts` (`X.toLayer`), `queries.ts` (`X.toQueryLayer`), `jobs.ts` (`X.toJobLayer`), `workflows/` — when a responsibility needs its own module: a browser client or another process imports the definition without the handlers, an executor layer deploys separately, or one file no longer reads as one responsibility. Do not create empty role files.
- `index.ts` exists only as a package or subpath entry and names real files; no `./*` wildcard exports.
- Unit and integration tests are `x.test.ts` beside the corresponding `src/x.ts`, one test file per source file. Browser E2E specs alone live outside source under `apps/e2e/` as `*.e2e.ts`.
- Every deviation is one entry in `tooling/structure/src/exemptions.ts` with a reason; an entry that matches nothing fails the check.

Two checks implement this specification, each owning different rules. Per-file oxlint rules in `tooling/oxlint` check file and folder names (`filename-kebab-case`, `no-parent-echo-in-filename`, `no-role-suffix-filename`, `no-generic-directory-segment`) and the runtime import boundary (`no-runtime-import-outside-runtime`). The tree checker in `tooling/structure` (`bun run lint:structure`) reads every `package.json` and owns package names, dependency direction, explicit `exports` with no wildcards, `index.ts` placement, and colocated tests. Module size is not checked: split a module when its responsibilities diverge, not to satisfy a count.

## Ways to run, mapped to the tree

- **Embedded:** an application provides `Actors.layer` from `@rikalabs/akter/runtime` and calls actors as Effects.
- **Served:** `Actors.serve` in its own process; the `docker/` images and a customer's BYO runner are this shape. There is no `apps/runner`: a managed runner is the customer's served container started by a `Deployment` actor job.
- **Hosted:** the same layer on our runners behind `apps/edge`, with Neki as the database.

## Implemented, planned and published

A directory exists when it holds code; there are no `.gitkeep` reservations for planned work. A planned package, command or folder is named in its design document until its first real module and test land. Do not add placeholder passing tests.

`apps/cli` ships the `durable` bin, built with Effect's `effect/cli` module, as a working local development, deploy-check, adoption and operator tool. New commands, hosted ones included, use `effect/cli` too. Current commands: `dev`, `workflows check`, `payloads`, `adopt`, `fleet`, `defects`, `inspect`, `export`, `receipts`, `dead-letters`, `subscriptions` and `tenants` ([CLI reference](../api/06-cli.md)). Hosted `login`, `deploy` and `migrate` commands are not implemented and have no reserved directories ([ADR 0063](../decisions/0063-framework-simplification.md)).

`@rikalabs/akter` is the one published package today. The workspace resolves its entries to TypeScript sources; `bun run --cwd packages/akter build` emits `dist/`, and `publishConfig` points the tarball's `exports` and `types` there. `.github/src/pack.ts` stages and checks the tarball in CI, and `.github/workflows/release.yml` publishes it on a `v<version>` tag ([ADR 0029](../decisions/0029-licence-package-name-and-release-policy.md); the first publish is CR.1b, [#99](https://github.com/Rika-Labs/akter/issues/99)). `@akter/create` stays private until that release; its build resolves the scaffold's pinned versions from the workspace catalog, and `.github/src/release/quickstart.ts` installs both tarballs into each generated app.
