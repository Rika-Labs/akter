# Automation contracts

Merge target is main. Human branches use `feat|fix|chore|docs|refactor|test|ci/<slug>`, optionally with an issue number in the slug; Dependabot gets a narrow author+branch exception. Titles remain plain language. No workflow force-pushes or auto-merges. Only `Release` publishes: tagged releases, `next` canaries after a green main push and `rewrite` canaries after a green `rewrite/0.2` push. This public repository does not deploy anything.

`Verify` runs all PRs, including forks, on GitHub-hosted `ubuntu-24.04`, without long-lived repository secrets or persisted checkout credentials. `Trusted policy` uses the same hosted image but still checks out only main code under `pull_request_target`; it never executes PR code. `Stress`, `Nightly properties` and `Release` use GitHub-hosted `ubuntu-latest`. Hosted minutes are free for this public repository; the launch comparison measured Verify at 3.9 minutes hosted versus 8.1 minutes on Namespace. Release must stay hosted because npm trusted publishing rejects self-hosted runners.

`Evidence gate` and its `Current SHA evidence` check are removed. Configure branch rules to require `verify` (the aggregate job) and `branch`, with no obsolete evidence check. At launch preparation the active main ruleset already requires only those two checks. Verify still records the exact head SHA, job results and logs in its artifacts; it does not replay test results. Review workflow edits like any other privileged automation change. A review-complete label is informational, never proof or merge permission; independent review remains required.

## Framework tarball and release

`bun run check` ends with `bun run pack:check`, which runs `bun .github/src/pack.ts`; `check:pack`, which `check:ci` and the `static` job run, calls it with `--smoke`. It removes both packages' old `dist` directories and builds `@rikalabs/akter` and `@rikalabs/akter-cli` once through Turbo's write-only local cache, stages their tarballs with `publishConfig` applied and `catalog:` versions resolved, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or crash fixtures would ship, when a dependency is unresolved, when a manifest is private or its version is not semantic, or when compiled code imports an undeclared package. A pack check never accepts a cached build; its freshly validated output populates Turbo's exact-input cache so subsequent workspace checks need not build it again. `--smoke` passes those same stages to independent Node and Bun clean consumers concurrently, instead of rebuilding both packages for each consumer. The existing owned-process-group runner terminates both consumers on failure or interruption; each smoke uses `BunRuntime.runMain` so signal handling finalizes its scoped, detached child processes rather than orphaning them. Standalone `pack:smoke` still builds when no stage is supplied, and Release still validates its explicitly staged packages. The CLI tarball includes `@rikalabs/akter-cli/cloud-api` as JS and declarations; the private `@akter/cloud-api` workspace is not a separate publish unit. Its output lands in `pack/check.log` of the `static` job's `evidence-part-static` artifact. Root scripts keep the local and workflow checks identical.

`Release` runs on a pushed `v<version>` tag or a manual dispatch naming that tag. It checks that both source versions match, the tag matches the framework version, the commit is on main, and a completed successful Verify run exists for that exact SHA. It installs npm 12.2.0, packs both packages and runs the clean-consumer smoke on Node and Bun, including cloud-API declarations, imports, endpoint and schema checks. Each package publishes once through OIDC, using its prerelease channel or `latest` for a stable version. Before 1.0, prereleases other than reserved `next` also advance `latest`; a newer `latest` is never moved backwards by a historical rerun. Publish and tag promotion are separate operations; rerunning a partial release skips existing immutable versions and retries promotion.

The same `release.yml` handles a `workflow_run` event after a successful Verify **push** run on **main**, checks out that run's SHA and packs a canary `<base>-next.<release-run-id>.<attempt>.g<sha12>`. Superseded runs are skipped unless the verified SHA matches the workflow's default-branch SHA; the checked-out commit must also match `GITHUB_SHA` before any publication, so npm provenance identifies the code actually packed. Manual tagged releases must dispatch on the matching tag ref. Both manifests and the CLI's framework dependency use the canary version without editing source manifests. Only `next` moves: no `latest`, `alpha`, GitHub Release or release notes. Fork/PR Verify runs and unsuccessful or manually dispatched runs cannot publish canaries. The shared concurrency group serializes publishing jobs.

A push to `rewrite/0.2` runs `release.yml` directly (a `workflow_run` event would execute the default-branch file), waits for the successful Verify push run on that SHA, requires the commit to be on `origin/rewrite/0.2` and equal to `GITHUB_SHA`, and publishes `<base>-rewrite.<run-id>.<attempt>.g<sha12>` under the `rewrite` dist-tag. `version.ts --canary-branch` maps `main` to `next` and `rewrite/0.2` to `rewrite` and refuses every other branch; neither channel advances `latest`.

Both channels use the `npm` environment and job-scoped `id-token: write`; no npm secret or auth-token environment variable is configured. The trusted publishers for both packages must name `release.yml` / `npm` and allow both `npm publish` and `npm dist-tag`. The environment must allow main and `v*`; reviewers, if configured, approve canaries too. At launch preparation the environment has no reviewers or deployment restrictions, so a maintainer must decide and apply those protections. A new package still needs its interactive bootstrap before trusted publishing. [Releasing](../docs/operations/05-releasing.md) describes setup and recovery. The workspace `prepublishOnly` scripts refuse local publishing from source packages.

## Node runtime evidence

`bun run test:node:units` launches Vitest with Node rather than Bun for the units that depend on the platform: origin checks and the mTLS peer transport. Locally, `check:ci` runs the Node and Bun tarball quickstarts before parallel checks, so packing cannot race Turbo's builds. It then runs `test:node:core` and the Turbo checks concurrently through `.github/src/verify.ts`. Checks run in owned process groups: failure or interruption terminates the sibling and its test-worker descendants; `--affected` is forwarded only to Turbo. In CI the `node-units` shard of the `suites` job runs `test:node:units`. `typecheck:ci`, root lint, and real child-process tests cover the runner. Node 24+ is required; the existing Verify environment supplies Node 26.

## Caches

`.github/actions/setup` restores Bun's package store from the GitHub cache. Only `static` saves the shared package-store cache; other jobs restore it. `static` also persists `.turbo/cache`, with an OS, architecture, pinned Bun/Node and lockfile namespace and a head-SHA save key. A restore from the same namespace can cross commits, but Turbo accepts a task result only when its complete task hash matches. Loose TypeScript incremental metadata is not restored. GitHub's PR cache scoping prevents fork PR caches from being restored by main or trusted policy. No Namespace cache-volume action or account is used. The trusted policy job installs frozen dependencies without using PR artifacts.

Turbo can reuse successful builds, lint and typecheck across jobs and commits with identical task inputs. Tests never replay: all `test`, `test:integration` and `test:e2e` tasks are explicitly uncached. `static` additionally builds first, then runs `test test:integration` with `--only --force`, so a required `verify` never passes on a cached test result. The framework suites call Vitest directly and are never cached. The real-Turbo regression runs the same unit task twice and checks two actual executions, as well as dependency and lint-plugin invalidation.

`check:static` runs the independent directives, structure, format and CI typechecks concurrently through Turbo, followed by fresh `.github/src` tests. These root checks retain Turbo's default repository-wide Git inputs, including nested workspace documentation and source; they do not use the workspace tasks' documentation exclusions. The real-Turbo regression proves that an unchanged root check reuses its result, while nested documentation and source changes each execute it again. A fresh evaluation disables task-cache reads; warm replay is reported separately, and compiler incremental state is not claimed cold.

## Parallel checks and cache boundaries

PRs compare the exact head SHA with the PR base SHA using `--affected`; full Git
history makes that comparison available. Main and manual runs check the entire
graph, reusing exact task results. This avoids skipping an earlier failed or
canceled main change merely because it was absent from the latest commit.
Obsolete runs are canceled at workflow scope.

Lint, typecheck, unit tests and builds run independently across workspaces.
Only tasks consuming build artifacts wait for builds. Typechecks and typed lint
use transit dependencies: dependency source changes invalidate downstream checks
without serializing their execution. Task-level inputs exclude documentation;
root TypeScript configuration, lint plugins, Vitest configuration, and the
`.github` verification sources are included in their owning checks.
The real-Turbo regression test exercises these invalidation boundaries.

## Job layout

`Verify` runs these jobs on `ubuntu-24.04`. Code-running jobs check out the exact head SHA; `static` and `suites` use `.github/actions/setup` to install Bun 1.4.2 and Node 26.7.0, restore caches and run the frozen install and `bun run prepare`. The planner uses the GitHub API and the aggregate collects evidence.

- `changes`: decides whether the test suites run. They are skipped only when a pull request changes nothing but `docs/` and Markdown files, when a push to main changes only those, or when a push to main has exactly the tree of a merged pull request whose `Verify` run succeeded. The file lists fail closed: a pull request of 3,000 or more files, a push comparison of 300 or more files (the compare API's limit) or a failed lookup always runs the suites. Its step summary names the reason.
- `static`: always runs. `check:static` (directives, structure, format, `typecheck:ci`, all `.github/src` tests), Turbo `lint lint:root typecheck`, `check:pack` (pack check and the tarball quickstart and cloud-API imports on Node and Bun), then, when the suites run, Turbo `build` and `test test:integration` for the public CLI, cloud API contract and tooling workspaces except `@akter/conformance`, whose suites run in `suites`.
- `suites`: one matrix job (`shards-1`) that runs its shards one after another and reports each shard's exit status and duration in the step summary: `framework-unit` runs the framework and conformance units on Bun, and `node-units` runs `test:node:units` on Node. Each shard keeps its own evidence directory. The 0.1 Postgres, PGlite, Node conformance and crash-drill shards were retired with the 0.1 runtime; `docs/verification/0.1-retirement.md` maps each to its replacement.
- `verify`: waits for `changes`, `static` and `suites`, merges each job's `evidence-part-*` artifact into `evidence-<sha>`, and fails unless every job succeeded or the suites were skipped for a reason `changes` recorded.

`static` and the suite job can start together, within GitHub Actions concurrency limits. There is no Namespace concurrency or billing dependency.

`check:ci` still runs everything in one process group for a local run. Unlike the old single job, the framework suites are not skipped by `--affected`; only Turbo's tasks are.

Every job caches Bun's package store, not mutable `node_modules`; on GitHub-hosted runners one job per workflow saves it. Do not restore loose TypeScript incremental metadata across commits: since the repository split, state another commit saved made `tsc` report `@rikalabs/akter` imports as unresolvable in whichever workspace a change affected, while a clean typecheck of the same tree passed. The persisted Turbo cache instead restores successful exact task results and their declared outputs on a matching hash. Do not add ESLint's per-file cache under typed lint: this repository uses Oxlint, and cross-file type changes matter.

Inside a job, Turbo concurrency follows available CPUs. Oxlint uses one thread per package, Go-based TypeScript tools inherit `GOMAXPROCS=1`, and each Vitest process allows two isolated workers. Docker and subprocess crash drills explicitly use `--no-file-parallelism`, which also limits their runner to one worker, preserving their exclusive timing and resource ownership. No isolation is disabled.

`static` and `suites` upload their logs and Turbo summaries as `evidence-part-*`, including on failure, and `verify` merges them into `evidence-<sha>` with the checked SHA and job results. Those artifacts remain for debugging and review, not a second privileged merge gate. Use Actions step durations to separate setup from test time before adding jobs.

To rebalance, move a shard line between matrix entries in `ci.yml`.

[Pipeline performance evidence](../docs/verification/pipeline-performance.md) records the repeated local comparison, exact-input cache controls, retained backend and failure coverage, rejected Postgres pooling and hosted measurement limits.

Sources: [Turbo task graphs](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
[Turbo caching](https://turborepo.dev/docs/crafting-your-repository/caching),
[Actions caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

## Dependabot and Bun catalogs

Dependabot supports `package-ecosystem: bun` ([official announcement](https://github.blog/changelog/2025-02-13-dependabot-version-updates-now-support-the-bun-package-manager-ga/)). However the current [Bun parser](https://github.com/dependabot/dependabot-core/blob/main/bun/lib/dependabot/bun/file_parser.rb#L163-L185) explicitly skips `catalog:` entries; [its parser test](https://github.com/dependabot/dependabot-core/blob/main/bun/spec/dependabot/bun/file_parser_spec.rb#L67-L93) verifies that skip. It does not traverse workspaces.catalog/catalogs. Do not claim catalogs are covered by Dependabot.

Equivalent local update adapter:

```sh
bun .github/src/update-catalogs.ts package.json          # registry-backed report, no writes
bun .github/src/update-catalogs.ts package.json --write  # local manifest + Bun lock update
```

The adapter uses standard `npm view` registry metadata, updates default/named Bun catalogs, and excludes majors/downgrades/prereleases. Effect, TS/native and Oxlint are a coupled cohort: changes are held for explicit compatibility work. Prerelease pins never silently promote, even to stable. Test updates with `bun run check`, build, and provider typecheck before review. No publishing or automatic merge is included.

Dependabot is turned off for this repository; dependency updates, catalog or not, are local commands; there is no GitHub Amp plugin or webhook/scheduled dispatch to orbs.

### Compatibility pins (2026-09-20 audit)

- Effect and its adapters are on the stable `4.0.0`; Effect's `unstable/*` modules graduated to `effect/<area>` (for example `effect/sql`, `effect/http-api`). Vitest 5 matches the adapter's peer range.
- Oxlint/plugins stay at `1.82.0` with `oxlint-tsgolint` `7.0.2001`. `@effect/tsgo` `0.45.0` rejects the newer Oxlint patch target; update this cohort together when supported.
- Oxlint's `RuleTester` requires Node >=22 and rejects Bun. Its package test script uses `npm exec --package=node@26.7.0` and prints the selected version, so local and CI runs do not depend on the runner's default Node. This requires npm and registry access on a cold npm cache; it installs only into npm's cache, not the repository or global toolchain. Use `npm exec`, not `npx`, which Bun rewrites to `bun x` in package scripts. The vendored anti-slop rule files run through Node's test runner, not Vitest. Directive tests and application tests still run on Bun. No tests or evidence checks are skipped.

Frozen installation, the Effect compiler patch, and full workspace checks are required after changing these pins.

Every action in these workflows and in `.github/actions/setup` is pinned to a full commit SHA.

An `AMP_TOKEN` secret alone does not enable issue replies or pull request reviews.
This repository does not define an Amp mention or review workflow. Those behaviors
require a separately configured integration; the verification and evidence workflows
do not invoke Amp.
