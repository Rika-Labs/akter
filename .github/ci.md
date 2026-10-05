# Automation contracts

Merge target is main. Human branches use `feat|fix|chore|docs|refactor|test|ci/<issue>-slug`; Dependabot gets a narrow author+branch exception. Titles remain plain language. No workflow force-pushes or auto-merges, only `Release` publishes, from a maintainer's tag, and only `Deploy` deploys.

`Verify` runs PR code without long-lived repository secrets or persisted checkout credentials on Blacksmith. `Trusted policy` and `Evidence gate` execute only main code. The gate checks successful current-head-SHA run/artifact metadata through Distilled and refuses a PR-modified verification workflow. It never extracts or executes PR artifacts. A policy workflow change therefore requires a separately approved rollout. Configure branch rules to require `verify`, `branch`, and `Current SHA evidence`; those settings were not applied. A review-complete label is informational, never proof or merge permission. Artifact metadata establishes executed CI provenance, not correctness of arbitrary PR tests; independent review remains required.

## Deploy

`Deploy` runs Alchemy against Fly.io from `infra/`. A first job, on an Arm runner, decides which stages to touch from the event and a second applies them, one matrix entry per stage, each with the secrets of one GitHub environment; [ADR 0089](../docs/decisions/0089-fly-infrastructure-and-environments.md) describes the stages and environments and `infra/README.md` the bootstrap.

| Event                                                           | Stage      | Environment  | Operation                                               |
| --------------------------------------------------------------- | ---------- | ------------ | ------------------------------------------------------- |
| Pull request from this repository opened, reopened or pushed to | `pr-<n>`   | `preview`    | deploy                                                  |
| That pull request closed                                        | `pr-<n>`   | `preview`    | destroy                                                 |
| `Verify` succeeds for a push to `main`                          | `prod`     | `production` | deploy the verified commit, with no approval step       |
| The same push changed `infra/` or this workflow                 | `preview`  | `preview`    | deploy                                                  |
| Manual run from `main`, choosing `prod` (default) or `preview`  | the choice | by stage     | deploy                                                  |
| Nightly schedule                                                | `pr-<n>`   | `preview`    | destroy each stage whose pull request is no longer open |

The `preview` stage owns the Neki cluster and Axiom datasets that the previews share and must exist before the first preview. Each stage has its own concurrency group, so runs of one stage queue instead of overlapping or cancelling one that is applying, and two deploys of `prod` never run at once. `infra`'s `guard` script refuses an unknown stage and any destroy of `prod` or `preview` from CI, and the workflow refuses to destroy anything but `pr-<n>`. Fork and Dependabot pull requests never run it, and a manual run from another branch does nothing.

Nothing waits for a reviewer: the `production` environment accepts deployments from `main` alone, so a merge that passes `Verify` reaches production. Feature flags, not the workflow, keep unfinished work dark.

Unlike `Verify`, this workflow runs pull-request code with the `preview` environment's secrets. Any collaborator who can push a branch to this repository can read them through a workflow change, so give that environment credentials that reach preview resources only, including a state database of its own, and keep production credentials in `production`. The Vercel token is the one secret both share.

Fly Machines run amd64 only, so the apply job runs on `ubuntu-24.04` and builds `linux/amd64` images natively.

## Framework tarball and release

`bun run check` ends with `bun run pack:check`, which runs `bun .github/src/pack.ts`; `check:ci`, and so `Verify`, runs it before Turbo so that `check:ci --affected` still reaches Turbo, which Bun appends script arguments to. It builds `@rikalabs/akter`, stages the tarball with the `publishConfig` entries applied and `catalog:` versions resolved, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or the crash fixtures would ship, when a dependency is unresolved, when the manifest is private or its version is not semantic, or when compiled code imports an undeclared package. Its output lands in `evidence/check.log`. It lives in the root scripts rather than a new workflow step because the evidence gate refuses a pull request that changes `ci.yml`.

## Streaming replica for read-your-writes

`check:ci` runs `bun .github/src/replica.ts` and passes the connection string it prints as `TEST_REPLICA_DATABASE_URL`. It stays in the root scripts for the same reason. The script finds the container that publishes `TEST_DATABASE_URL`'s port (the `postgres` service), admits replication connections in its `pg_hba.conf`, and starts `durable-replica`, a `pg_basebackup` clone of it on port 5433 that follows the primary as a physical streaming replica. `.github/src/node-postgres.ts` creates `durable-node-postgres` on port 5435 for Node, and `replica.ts` clones that primary with `TEST_REPLICA_CONTAINER=durable-node-replica TEST_REPLICA_PORT=5434`. Fleet's logical slot name is cluster-global, and the read-your-writes cases pause replay server-wide, so concurrent runtimes must have separate primaries and replicas. Control connections wait only for the newly created database to reach the standby; subsequent version checks and queries are not retried. Without `TEST_DATABASE_URL` or Docker the replica bootstrap prints nothing; with `CI` set, the script and Postgres suite fail instead. Startup refuses an existing container instead of deleting it. Locally, remove only the exact containers you created, including their replicas; never prune the shared Docker daemon.

`Release` runs on a pushed `v<version>` tag, or by manual dispatch with that tag as its `tag` input; CR.1b (#99) owns the first publish. It checks out the tag, checks that it matches `packages/akter/package.json` and that the tagged commit is on main, checks the runner's npm is at least 11.5.1, packs with the same script, installs the tarball into a clean project with `bun .github/src/release/smoke.ts` (typecheck plus one command on PGlite), and runs `npm publish --provenance --access public` through npm Trusted Publishing. The job uses the `npm` environment and its job-scoped `id-token: write` permission, so npm exchanges the GitHub Actions OIDC identity for a short-lived publish credential; no npm secret or auth-token environment variable is configured. A maintainer can require environment reviewers, and a tag ruleset on `v*` limits who can start a release. npm can only trust a package that already exists, so the first version is published by hand; [Releasing](../docs/operations/05-releasing.md) has the bootstrap. A prerelease version publishes to the dist-tag named by its first prerelease identifier (`0.1.0-alpha.0` goes to `alpha`); that id must start with a letter, and a version without one goes to `latest`. It runs on a GitHub-hosted runner because npm provenance does not accept self-hosted runners, and provenance requires the repository to be public. The workspace `prepublishOnly` script refuses a local `npm publish` from the source package.

## Node runtime evidence

`bun run test:node` launches Vitest with Node rather than Bun, runs every core Postgres conformance shard, checks client error reporting, durable routing, compression compatibility and kernel-lock refusal/recovery, and runs the installed-tarball quickstart on Node, including a file-backed PGlite process restart and injected failures before and after commit. `check:ci` runs the Node and Bun tarball quickstarts before parallel checks, so packing cannot race Turbo's builds. It then runs `test:node:core` and the existing Turbo checks concurrently through `.github/src/verify.ts`, with a separate primary and replica for each runtime, to preserve Verify's existing 20-minute budget. Checks run in owned process groups: failure or interruption terminates the sibling and its test-worker descendants; `--affected` is forwarded only to Turbo. `typecheck:ci`, root lint, and real child-process tests cover the runner. Node 24+ is required; the existing Verify environment supplies Node 26. No verification workflow changes are needed or permitted for this slice. The separate actor subprocess crash drills retain their Bun runner and are not claimed as Node crash evidence; the fleet-maintainer core case and PGlite kernel-lock subprocess cases run on Node too.

## Turborepo remote cache

`Verify` uses `vercel/setup-turborepo-remote-cache-action@v1.1.0` with job-scoped
`id-token: write` and the repository-accessible organization/repository variable
`TURBO_TEAM`. The action exchanges GitHub OIDC for a short-lived cache token and
exports `TURBO_TOKEN` and `TURBO_TEAM` before `bun run check:ci`.
No PAT or `TURBO_TOKEN` secret is required. Other workflows do not run Turbo.

The cache setup runs on main pushes/manual runs and same-repository PRs, excluding Dependabot.
Fork and Dependabot PRs still run checks without the cache setup. Scope the Vercel
OIDC policy to this repository and workflow, allowing the intended push/PR claims;
the step condition is not a replacement for provider-side policy restrictions.
If multiple policies match, the action needs an explicit `policy` input. OIDC
exchange must be verified in GitHub Actions; local validation cannot exercise it.
`TYPESAFE_API_KEY` is unrelated to Turbo authentication and is not exposed to these
build steps.

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
`.github` sources consumed by infra are included in their owning checks.
The real-Turbo regression test exercises these invalidation boundaries.

File-scoped type-aware lint exceptions are limited to platform boundaries:
`effecttsgo/async-function` plus `effecttsgo/process-env` for the imperative
Playwright project in `apps/e2e`. Playwright's test functions return promises
and its configuration reads `CI` directly. `examples/chat/src/web/app.ts` is
browser code written against the Promise client, the way an application without
Effect uses it, so `async-function`, `global-fetch`, `global-timers`, and
`instance-of-schema` are off there, as `instance-of-schema` is for the chat
example's Promise-client script. `packages/react/src` holds React hooks, whose
effects and event handlers are Promise code and whose exports are React APIs,
not pipeable Effect functions, so `async-function` and
`missing-pipeable-signature` are off there. All other rules still run on these files.

Blacksmith automatically accelerates upstream `actions/cache@v6`. All three
workflows cache Bun's package store, not mutable `node_modules`. Verify also
restores TypeScript incremental metadata using a toolchain/configuration key and
a per-commit snapshot. TypeScript validates that state on a Turbo miss; Turbo
restores successful exact results on a hit. Do not add ESLint's per-file cache
under typed lint: this repository uses Oxlint, and cross-file type changes matter.
Keep Blacksmith's branch-protected cache setting enabled.

Turbo concurrency follows available CPUs. Oxlint uses one thread per package,
Go-based TypeScript tools inherit `GOMAXPROCS=1`, and each Vitest process uses one
isolated worker. This avoids multiplying a package-level worker pool by another
CPU-sized pool. No isolation is disabled. PostgreSQL integration results are
never cached; their task is selected by the affected graph and requires explicit
disposable database configuration.

Every Verify run uploads exact-SHA evidence and `.turbo/runs` summaries, including
on failure. The evidence gate still requires a successful current-SHA run. Use
the summaries and Actions step durations to distinguish queue/install time from
task execution before changing runner sizes or introducing more jobs.

As suites grow, shard the slow package rather than every package. Vitest already
accepts `--shard=1/4` through a filtered Turbo invocation, for example
`bun run test --filter=@project/console -- --shard=1/4`. Allocate one Blacksmith job per
shard only when measured execution savings exceed repeated checkout/install cost;
merge blob reports and require every shard before publishing aggregate evidence.
Keep shard arguments in the Turbo invocation so each shard gets a distinct cache
key. Historical balancing needs real timing data; no speculative scheduler is
installed. The separate `apps/e2e` Playwright project runs in `check:ci`
after Chromium headless-shell installation. It checks the console's read-only
fixture in a real browser, not the live auth or billing providers. Run
`bun run test:e2e` locally after installing Playwright Chromium.

Sticky disks are not interchangeable with branch-isolated Actions caches: they
share snapshots across repository workflows by default. Enable Blacksmith sticky
disk branch protection before adopting its cached checkout or Docker builder.
For an actual container-build workflow, use `useblacksmith/setup-docker-builder`
with one cache key per image workload and its matching build action; do not also
export large BuildKit caches to GitHub. Current Verify builds Bun artifacts and
does not publish images or deploy infrastructure.

Sources: [Turbo task graphs](https://turborepo.dev/docs/crafting-your-repository/configuring-tasks),
[Turbo caching](https://turborepo.dev/docs/crafting-your-repository/caching),
[Blacksmith Actions caching](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions),
[sticky-disk trust boundaries](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks),
[Docker caching](https://docs.blacksmith.sh/blacksmith-caching/docker-builds).

## Dependabot and Bun catalogs

Dependabot supports `package-ecosystem: bun` ([official announcement](https://github.blog/changelog/2025-02-13-dependabot-version-updates-now-support-the-bun-package-manager-ga/)). However the current [Bun parser](https://github.com/dependabot/dependabot-core/blob/main/bun/lib/dependabot/bun/file_parser.rb#L163-L185) explicitly skips `catalog:` entries; [its parser test](https://github.com/dependabot/dependabot-core/blob/main/bun/spec/dependabot/bun/file_parser_spec.rb#L67-L93) verifies that skip. It does not traverse workspaces.catalog/catalogs. Do not claim catalogs are covered by Dependabot.

Equivalent local update adapter:

```sh
bun .github/src/update-catalogs.ts package.json          # registry-backed report, no writes
bun .github/src/update-catalogs.ts package.json --write  # local manifest + Bun lock update
```

The adapter uses standard `npm view` registry metadata, updates default/named Bun catalogs, and excludes majors/downgrades/prereleases. Effect, Alchemy/BetterAuth, FoldKit, TS/native and Oxlint are a coupled cohort: changes are held for explicit compatibility work. Prerelease pins never silently promote, even to stable. Test updates with `bun run check`, build, and provider typecheck before review. No publishing or automatic merge is included.

Dependabot is turned off for this repository; dependency updates, catalog or not, are local commands; there is no GitHub Amp plugin or webhook/scheduled dispatch to orbs.

### Compatibility pins (2026-09-20 audit)

- Effect and its adapters are on the stable `4.0.0`; Effect's `unstable/*` modules graduated to `effect/<area>` (for example `effect/sql`, `effect/http-api`). FoldKit `0.163.0` still declares rc116 peers; the console only imports modules that work on 4.0.0. Vitest 5 matches the adapter's peer range.
- Drizzle ORM and Kit use the matching `rc5` snapshot `1.0.0-rc.5-5935859`; this is an intentional prerelease channel, not a stable-version claim.
- Oxlint/plugins stay at `1.82.0` with `oxlint-tsgolint` `7.0.2001`. `@effect/tsgo` `0.45.0` rejects the newer Oxlint patch target; update this cohort together when supported.
- Oxlint's `RuleTester` requires Node >=22 and rejects Bun. Its package test script uses `npm exec --package=node@26.7.0` and prints the selected version, so local and CI runs do not depend on the runner's default Node. This requires npm and registry access on a cold npm cache; it installs only into npm's cache, not the repository or global toolchain. Use `npm exec`, not `npx`, which Bun rewrites to `bun x` in package scripts. The vendored anti-slop rule files run through Node's test runner, not Vitest. Directive tests and application tests still run on Bun. No tests or evidence checks are skipped.
- Babel uses 8.0.6 with the newest v8 TypeScript transform (8.0.0-rc.6). Babel supplies its own types; StyleX is loaded through Babel's plugin resolver. Node types use 26.6.2. The application runtime remains Bun 1.4.2.
- CI and Compose use PostgreSQL 18.6. Orb setup installs PostgreSQL 18 from the official PGDG repository. Compose mounts the v18 image at `/var/lib/postgresql`, using a separate `postgres18` volume; orbs use `.local/postgres18`. Older volumes/directories are preserved, not migrated or deleted. Existing development data needs an explicit dump/restore or reviewed major-version upgrade before reuse.

Frozen installation, the Effect compiler patch, and full workspace checks are required after changing these pins. Historical `research/` snapshots are not active dependency manifests and remain unchanged.

Blacksmith runner startup and Vercel OIDC authentication have been exercised in GitHub Actions. Pin action refs to reviewed immutable revisions before enabling in a sensitive repository; current version tags are conventional bootstrap refs.

An `AMP_TOKEN` secret alone does not enable issue replies or pull request reviews.
This repository does not define an Amp mention or review workflow. Those behaviors
require a separately configured integration; the verification and evidence workflows
do not invoke Amp.
