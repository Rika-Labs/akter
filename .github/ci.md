# Automation contracts

Merge target is main. Human branches use `feat|fix|chore|docs|refactor|test|ci/<slug>`, optionally with an issue number in the slug; Dependabot gets a narrow author+branch exception. Titles remain plain language. No workflow force-pushes or auto-merges. Only `Release` publishes: tagged releases and `next` canaries after a green main push. This public repository does not deploy anything.

`Verify` runs all PRs, including forks, on GitHub-hosted `ubuntu-24.04`, without long-lived repository secrets or persisted checkout credentials. `Trusted policy` uses the same hosted image but still checks out only main code under `pull_request_target`; it never executes PR code. `Stress`, `Nightly properties` and `Release` use GitHub-hosted `ubuntu-latest`. Hosted minutes are free for this public repository; the launch comparison measured Verify at 3.9 minutes hosted versus 8.1 minutes on Namespace. Release must stay hosted because npm trusted publishing rejects self-hosted runners.

`Evidence gate` and its `Current SHA evidence` check are removed. Configure branch rules to require `verify` (the aggregate job) and `branch`, with no obsolete evidence check. At launch preparation the active main ruleset already requires only those two checks. Verify still records the exact head SHA, job results and logs in its artifacts; it does not replay test results. Review workflow edits like any other privileged automation change. A review-complete label is informational, never proof or merge permission; independent review remains required.

## Framework tarball and release

`bun run check` ends with `bun run pack:check`, which runs `bun .github/src/pack.ts`; `check:pack`, which `check:ci` and the `static` job run, calls it. It builds `@rikalabs/akter` and `@rikalabs/akter-cli`, stages their tarballs with `publishConfig` applied and `catalog:` versions resolved, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or crash fixtures would ship, when a dependency is unresolved, when a manifest is private or its version is not semantic, or when compiled code imports an undeclared package. The CLI tarball includes `@rikalabs/akter-cli/cloud-api` as JS and declarations; the private `@akter/cloud-api` workspace is not a separate publish unit. Its output lands in `pack/check.log` of the `static` job's `evidence-part-static` artifact. Root scripts keep the local and workflow checks identical.

## Streaming replica for read-your-writes

Every job that runs the Postgres conformance suites (`static` and the `suites` jobs) has its own `postgres` service container and runs `bun .github/src/replica.ts` to export the connection string it prints as `TEST_REPLICA_DATABASE_URL`; locally `check:ci` does the same. The script finds the container that publishes `TEST_DATABASE_URL`'s port (the `postgres` service), admits replication connections in its `pg_hba.conf`, and starts `durable-replica`, a `pg_basebackup` clone of it on port 5433 that follows the primary as a physical streaming replica. Locally, `.github/src/node-postgres.ts` creates `durable-node-postgres` on port 5435 for Node, and `replica.ts` clones that primary with `TEST_REPLICA_CONTAINER=durable-node-replica TEST_REPLICA_PORT=5434`; in CI every job is its own machine, so the Bun and Node suites never share a primary. Fleet's logical slot name is cluster-global, and the read-your-writes cases pause replay server-wide, so concurrent runtimes must have separate primaries and replicas. Control connections wait only for the newly created database to reach the standby; subsequent version checks and queries are not retried. Without `TEST_DATABASE_URL` or Docker the replica bootstrap prints nothing; with `CI` set, the script and Postgres suite fail instead. Startup refuses an existing container instead of deleting it. Locally, remove only the exact containers you created, including their replicas; never prune the shared Docker daemon.

`Release` runs on a pushed `v<version>` tag or a manual dispatch naming that tag. It checks that both source versions match, the tag matches the framework version, the commit is on main, and a completed successful Verify run exists for that exact SHA. It installs npm 12.2.0, packs both packages and runs the clean-consumer smoke on Node and Bun, including cloud-API declarations, imports, endpoint and schema checks. Each package publishes once through OIDC, using its prerelease channel or `latest` for a stable version. Before 1.0, prereleases other than reserved `next` also advance `latest`; a newer `latest` is never moved backwards by a historical rerun. Publish and tag promotion are separate operations; rerunning a partial release skips existing immutable versions and retries promotion.

The same `release.yml` handles a `workflow_run` event after a successful Verify **push** run on **main**, checks out that run's SHA and packs a canary `<base>-next.<release-run-id>.<attempt>.g<sha12>`. Superseded runs are skipped unless the verified SHA matches the workflow's default-branch SHA; the checked-out commit must also match `GITHUB_SHA` before any publication, so npm provenance identifies the code actually packed. Manual tagged releases must dispatch on the matching tag ref. Both manifests and the CLI's framework dependency use the canary version without editing source manifests. Only `next` moves: no `latest`, `alpha`, GitHub Release or release notes. Fork/PR Verify runs and unsuccessful or manually dispatched runs cannot publish canaries. The shared concurrency group serializes publishing jobs.

Both channels use the `npm` environment and job-scoped `id-token: write`; no npm secret or auth-token environment variable is configured. The trusted publishers for both packages must name `release.yml` / `npm` and allow both `npm publish` and `npm dist-tag`. The environment must allow main and `v*`; reviewers, if configured, approve canaries too. At launch preparation the environment has no reviewers or deployment restrictions, so a maintainer must decide and apply those protections. A new package still needs its interactive bootstrap before trusted publishing. [Releasing](../docs/operations/05-releasing.md) describes setup and recovery. The workspace `prepublishOnly` scripts refuse local publishing from source packages.

## Node runtime evidence

`bun run test:node` launches Vitest with Node rather than Bun, runs every core Postgres conformance shard, checks client error reporting, durable routing, compression compatibility and kernel-lock refusal/recovery, and runs the installed-tarball quickstart on Node, including a file-backed PGlite process restart and injected failures before and after commit. Locally, `check:ci` runs the Node and Bun tarball quickstarts before parallel checks, so packing cannot race Turbo's builds. It then runs `test:node:core` and the Turbo checks concurrently through `.github/src/verify.ts`, with a separate primary and replica for each runtime. Checks run in owned process groups: failure or interruption terminates the sibling and its test-worker descendants; `--affected` is forwarded only to Turbo. In CI the `node-conformance-*` and `node-units` shards of the `suites` jobs run `test:node:conformance` and `test:node:units` instead. `typecheck:ci`, root lint, and real child-process tests cover the runner. Node 24+ is required; the existing Verify environment supplies Node 26. The separate actor subprocess crash drills retain their Bun runner and are not claimed as Node crash evidence; the fleet-maintainer core case and PGlite kernel-lock subprocess cases run on Node too.

## Caches

`.github/actions/setup` restores Bun's package store from the GitHub cache. Only `static` saves the shared package-store cache; other jobs restore it. GitHub's PR cache scoping prevents fork PR caches from being restored by main or trusted policy. No Namespace cache-volume action or account is used. Typecheck metadata is restored only for the exact commit. The trusted policy job installs frozen dependencies without using PR artifacts.

Turbo can reuse builds, lint and typecheck within a job; its local task cache is not persisted between hosted runners. Tests never replay: `static` builds first, then runs `test test:integration` with `--only --force`, so a required `verify` never passes on a cached test result. The framework suites call Vitest directly and are never cached.

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

File-scoped type-aware lint exceptions are limited to platform boundaries:
`packages/react/src` holds React hooks, whose
effects and event handlers are Promise code and whose exports are React APIs,
not pipeable Effect functions, so `async-function` and
`missing-pipeable-signature` are off there. All other rules still run on these files.

## Job layout

`Verify` runs these jobs on `ubuntu-24.04`. Code-running jobs check out the exact head SHA; `static` and `suites` use `.github/actions/setup` to install Bun 1.4.2 and Node 26.7.0, restore caches and run the frozen install and `bun run prepare`. The planner uses the GitHub API, the aggregate collects evidence, and the self-host recipe builds its own runtime images.

- `changes`: decides whether the test suites run. They are skipped only when a pull request changes nothing but `docs/` and Markdown files, when a push to main changes only those, or when a push to main has exactly the tree of a merged pull request whose `Verify` run succeeded. The file lists fail closed: a pull request of 3,000 or more files, a push comparison of 300 or more files (the compare API's limit) or a failed lookup always runs the suites. Its step summary names the reason.
- `static`: always runs. `check:static` (directives, structure, format, `typecheck:ci`, all `.github/src` tests), Turbo `lint lint:root typecheck`, `check:pack` (pack check and the tarball quickstart and cloud-API imports on Node and Bun), then, when the suites run, Turbo `build` and `test test:integration` for the public CLI, clients, cloud API contract and tooling workspaces, with a Postgres service and replica.
- `suites`: seven matrix jobs (`shards-1` to `shards-7`), each with its own Postgres service, that run their shards one after another and report each shard's exit status and duration in the step summary. A shard keeps its own Vitest command and evidence directory (`framework-postgres-*`, `node-conformance-*`, `framework-pglite-*`, `framework-unit`, `framework-drills`, `node-units`). Shards that must not see a replica (`framework-postgres-4`, the Neki migration file; the drills; the unit and PGlite shards, which also run without `TEST_DATABASE_URL`) run before the replica starts, because starting it restarts the primary with logical WAL. The existing shard assignments are retained during the runner move.
- `self-host-recipe`: builds and boots both self-host runtime images once `static` has passed; not part of `verify`.
- `verify`: waits for `changes`, `static` and `suites`, merges each job's `evidence-part-*` artifact into `evidence-<sha>`, and fails unless every job succeeded or the suites were skipped for a reason `changes` recorded.

`static` and the seven suite jobs can start together, within GitHub Actions concurrency limits; `self-host-recipe` waits for `static`. There is no Namespace concurrency or billing dependency.

`check:ci` still runs everything in one process group for a local run. Unlike the old single job, the framework suites are not skipped by `--affected`; only Turbo's tasks are.

Every job caches Bun's package store, not mutable `node_modules`; on GitHub-hosted runners one job per workflow saves it. There, `static` restores TypeScript incremental metadata only from a run of the same commit, never from another commit: since the repository split, state another commit saved made `tsc` report `@rikalabs/akter` imports as unresolvable in whichever workspace a change affected, while a clean typecheck of the same tree passed. Turbo restores successful exact results on a hit. Do not add ESLint's per-file cache under typed lint: this repository uses Oxlint, and cross-file type changes matter.

Inside a job, Turbo concurrency follows available CPUs. Oxlint uses one thread per package, Go-based TypeScript tools inherit `GOMAXPROCS=1`, and each Vitest process uses one isolated worker, except the integration, PGlite and Node shard configs, which allow two. No isolation is disabled. PostgreSQL integration results are never cached; their task is selected by the affected graph and requires explicit disposable database configuration.

`static` and `suites` upload their logs and Turbo summaries as `evidence-part-*`, including on failure, and `verify` merges them into `evidence-<sha>` with the checked SHA and job results. Those artifacts remain for debugging and review, not a second privileged merge gate. Use Actions step durations to separate setup from test time before adding jobs.

To rebalance, move a shard line between the matrix entries in `ci.yml`, or a project between shards; the project names are the keys of `shards` in `packages/akter/src/testing/conformance/postgres/shards.ts`, plus `conformance` for the groups no shard names and `integration`.

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
- Drizzle ORM and Kit use the matching `rc5` snapshot `1.0.0-rc.5-5935859`; this is an intentional prerelease channel, not a stable-version claim.
- Oxlint/plugins stay at `1.82.0` with `oxlint-tsgolint` `7.0.2001`. `@effect/tsgo` `0.45.0` rejects the newer Oxlint patch target; update this cohort together when supported.
- Oxlint's `RuleTester` requires Node >=22 and rejects Bun. Its package test script uses `npm exec --package=node@26.7.0` and prints the selected version, so local and CI runs do not depend on the runner's default Node. This requires npm and registry access on a cold npm cache; it installs only into npm's cache, not the repository or global toolchain. Use `npm exec`, not `npx`, which Bun rewrites to `bun x` in package scripts. The vendored anti-slop rule files run through Node's test runner, not Vitest. Directive tests and application tests still run on Bun. No tests or evidence checks are skipped.
- CI and Compose use PostgreSQL 18.6. Orb setup installs PostgreSQL 18 from the official PGDG repository. Compose mounts the v18 image at `/var/lib/postgresql`, using a separate `postgres18` volume; orbs use `.local/postgres18`. Older volumes/directories are preserved, not migrated or deleted. Existing development data needs an explicit dump/restore or reviewed major-version upgrade before reuse.

Frozen installation, the Effect compiler patch, and full workspace checks are required after changing these pins.

Every action in these workflows and in `.github/actions/setup` is pinned to a full commit SHA.

An `AMP_TOKEN` secret alone does not enable issue replies or pull request reviews.
This repository does not define an Amp mention or review workflow. Those behaviors
require a separately configured integration; the verification and evidence workflows
do not invoke Amp.
