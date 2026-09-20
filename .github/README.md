# Automation contracts

Merge target is main. Human branches use `feat|fix|chore|docs|refactor|test|ci/<issue>-slug`; Dependabot gets a narrow author+branch exception. Titles remain plain language. No workflow force-pushes, deploys, publishes or auto-merges.

`Verify` runs PR code without long-lived repository secrets or persisted checkout credentials on Blacksmith. `Trusted policy` and `Evidence gate` execute only main code. The gate checks successful current-head-SHA run/artifact metadata through Distilled and refuses a PR-modified verification workflow. It never extracts or executes PR artifacts. A policy workflow change therefore requires a separately approved rollout. Configure branch rules to require `verify`, `branch`, and `Current SHA evidence`; those settings were not applied. A review-complete label is informational, never proof or merge permission. Artifact metadata establishes executed CI provenance, not correctness of arbitrary PR tests; independent review remains required.

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
disposable database configuration. Live Proof inference is also outside Turbo's
deterministic cache and runs through the pre-push gate, never with a secret exposed
to untrusted PR code.

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
key. Historical balancing needs real timing data; no speculative scheduler or
empty E2E framework is installed in this template.

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

Dependabot remains configured for ordinary non-major dependency PRs. Catalog updates are local commands; there is no GitHub Amp plugin or webhook/scheduled dispatch to orbs.

### Compatibility pins (2026-09-20 audit)

- Effect and its adapters stay on `4.0.0-rc.116`; the npm `latest` tag on Effect's older major is not an upgrade. Vitest 5 matches the adapter's peer range.
- Drizzle ORM and Kit use the matching `rc5` snapshot `1.0.0-rc.5-5935859`; this is an intentional prerelease channel, not a stable-version claim.
- Oxlint/plugins stay at `1.82.0` with `oxlint-tsgolint` `7.0.2001`. `@effect/tsgo` `0.45.0` rejects the newer Oxlint patch target; update this cohort together when supported.
- Babel stays on the latest compatible 7.x line; Babel 8 requires a separate StyleX/build-tool migration. Node types stay on 24.x rather than following the newest Node major.
- CI and Compose use PostgreSQL 17.11. PostgreSQL 18 is a major storage upgrade, not an image-tag refresh. The orb setup still uses distribution PostgreSQL 15; do not reuse that data directory with a different major binary.

Frozen installation, the Effect compiler patch, and full workspace checks are required after changing these pins. Historical `research/` snapshots are not active dependency manifests and remain unchanged.

Blacksmith runner startup and Vercel OIDC authentication have been exercised in GitHub Actions. Proof and its TypeSafe provider now install from npm without sibling checkouts. Pin action refs to reviewed immutable revisions before enabling in a sensitive repository; current version tags are conventional bootstrap refs.

An `AMP_TOKEN` secret alone does not enable issue replies or pull request reviews.
This repository does not define an Amp mention or review workflow. Those behaviors
require a separately configured integration; the verification and evidence workflows
do not invoke Amp.
