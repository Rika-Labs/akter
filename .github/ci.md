# Automation contracts

Merge target is main. Human branches use `feat|fix|chore|docs|refactor|test|ci/<issue>-slug`; Dependabot gets a narrow author+branch exception. Titles remain plain language. Nothing force-pushes or auto-merges.

This public repository runs **no GitHub Actions on pull requests or pushes**. Only `Release` exists, because npm trusted publishing needs a GitHub-hosted runner's OIDC identity; the repository deploys nothing (Akter Cloud deploys from the private repository). All verification is local, and a pull request cannot merge until a maintainer or agent has run it on the exact head and signed it off.

## Local verification

```sh
bun run verify:local <pr> [--post --agent <name>] [--only id,id] [--keep]
```

`tooling/local-verify/manifest.json` lists the required checks and the two commit statuses the `main` ruleset requires. `verify` is green only when `self-host`, `static`, `pack`, `workspaces`, `framework-unit`, `framework-pglite`, `framework-postgres`, `framework-migrations`, `framework-drills`, `node-postgres` and `sandbox` all passed; `branch` is green when the branch policy passed, the head contains its base branch and the fetched head is the verified commit. A check that did not run is missing, never passing.

The command acquires the machine-wide heavy slots, fetches the pull request head, creates a throwaway checkout of that exact commit, installs it with the frozen lockfile, and runs each check in its own shell, with its own Postgres server 18.6 containers (and a streaming replica where the old job started one) on a private Docker network, removed afterwards by exact name. The runner, manifest and the policy scripts `.github/src/check-branch.ts` and `.github/src/policy.ts` come from the checkout that runs the command, never from the pull request; the sign-off states whether they equal `main` or the head's own, and refuses to post when they match neither or have uncommitted changes.

With `--post` it sets `verify` and `branch` as commit statuses on the exact head SHA, writes a tool-generated "Local verification" section into the pull request body, and, only when every check passed, posts one sign-off comment per head SHA. A failure posts failure statuses and a body section reading "Not signed off", with no comment. A push after the run leaves the new SHA without statuses until the command runs again. Agents never tick boxes or edit the generated section by hand.

Every check runs with `TURBO_FORCE=1` and fails if Turbo reports a cache hit, so a replayed result never counts toward a sign-off; the sign-off states the run was uncached.

`--only static,pack` reruns some checks; `--post` combines results from earlier runs of the same SHA, manifest and trusted tooling, so a partial rerun can complete a sign-off but can never invent one. `--inject-failure <id>` makes a check fail on purpose, to prove the failure path.

### Fork pull requests

A pull request whose author is not a listed maintainer and whose head is not a branch in this repository (and any bot author) runs inside a Docker sandbox: the checkout is the only mount, there is no home directory, secrets file, SSH agent socket, Docker socket or `gh` token, all capabilities are dropped, and the container's environment is built from scratch. Only the outer command, which never executes pull request code, posts statuses. `self-host` and `framework-drills` need the host Docker daemon and therefore do not run in the sandbox, so `verify` stays failing for such a head until a maintainer reads the diff and reruns with `--trust-reviewed <head sha>`, which runs those checks on the host and says so in the sign-off. The `sandbox` check runs the canary test (`bun run --cwd tooling/local-verify test:isolation`) from the trusted checkout: it plants a canary file beside `~/.config/akter/secrets.env` and proves the container cannot see it. The sandbox has network access (installs need the registry) and can therefore reach the local network.

### Optional suites

Scheduled runs became named suites that no pull request needs: `properties` (random seeds), `simulation` (10,000 new seeds per run) and `stress` (the framework suites repeated under CPU load, `--runs 1-25`). Run them against a pull request with `--only stress`, or against `main` with `bun run verify:local main --only stress`. They never post statuses. Their intended cadence is nightly on `main`, as the old workflows ran; no scheduler is configured here.

### Strictness

A failed `git` command stops the run. The `branch` check requires the head to contain the freshly fetched `main` tip and does not special-case stacked pull requests. Host checks run with an allowlisted environment. See [local verification](../docs/verification/local-verification.md). Run a full suite with a timeout of 7200 seconds.

### Releases and statuses on `main`

The release gate reads the `verify` and `branch` commit statuses of the tagged commit. A squash or merge commit on `main` is not the pull request head and has no statuses, so before tagging run `bun run verify:local main --commit <sha> --post --agent <name>`, which runs every required check on that exact commit and posts both statuses on it.

## Framework tarball and release

`bun run check` ends with `bun run pack:check`, which runs `bun .github/src/pack.ts`; `check:pack`, which the `pack` check and `check:ci` run, calls it. It builds `@rikalabs/akter`, stages the tarball with the `publishConfig` entries applied and `catalog:` versions resolved, runs `npm pack --dry-run`, and fails when a required file or export target is missing, when sources, tests or the crash fixtures would ship, when a dependency is unresolved, when the manifest is private or its version is not semantic, or when compiled code imports an undeclared package.

`Release` runs on a pushed `v<version>` tag, or by manual dispatch with that tag as its `tag` input; CR.1b (#99) owns the first publish. It checks out the tag, checks that it matches `packages/akter/package.json` and that the tagged commit is on main, requires the commit statuses `verify` and `branch` to be `success` on the tagged commit through the statuses API (`bun .github/src/release/gate.ts`; only the newest status of a context counts and a missing one blocks the release), checks the runner's npm is at least 11.5.1, packs with the same script, installs the tarball into a clean project with `bun .github/src/release/smoke.ts` (typecheck plus one command on PGlite), and runs `npm publish --provenance --access public` through npm Trusted Publishing. The job uses the `npm` environment and its job-scoped `id-token: write` permission, so npm exchanges the GitHub Actions OIDC identity for a short-lived publish credential; no npm secret or auth-token environment variable is configured. A maintainer can require environment reviewers, and a tag ruleset on `v*` limits who can start a release. npm can only trust a package that already exists, so the first version is published by hand; [Releasing](../docs/operations/05-releasing.md) has the bootstrap. A prerelease version publishes to the dist-tag named by its first prerelease identifier (`0.1.0-alpha.0` goes to `alpha`); that id must start with a letter, and a version without one goes to `latest`. It runs on a GitHub-hosted runner because npm provenance does not accept self-hosted runners, and provenance requires the repository to be public. The workspace `prepublishOnly` script refuses a local `npm publish` from the source package.

Every action in `release.yml` and in the composite `.github/actions/setup` is pinned to a full commit SHA with its version in a comment, and the job that publishes restores or saves no cache, so a lower-trust job cannot poison what a credentialed job runs. `.github/actions/setup` stays because the private Akter Cloud repository consumes it through its `akter/` submodule; this repository no longer uses it.

## Streaming replica for read-your-writes

The Postgres conformance suites read `TEST_REPLICA_DATABASE_URL`. `verify:local` starts the replica itself (`tooling/local-verify/src/postgres.ts`): a `pg_basebackup` clone of the primary on the same private network, following it as a physical streaming replica through a named slot, reachable as `replica`. The primary starts with `wal_level=logical`. `framework-postgres` and `node-postgres` give every conformance group its own primary and replica, because Fleet's logical slot name is cluster-global and the read-your-writes cases pause replay server-wide, so concurrent runtimes must have separate primaries and replicas.

`bun .github/src/replica.ts` and `.github/src/node-postgres.ts` remain for a hand-run `check:ci`: `replica.ts` finds the container that publishes `TEST_DATABASE_URL`'s port, admits replication connections in its `pg_hba.conf`, and starts `durable-replica` on port 5433; `node-postgres.ts` creates `durable-node-postgres` on port 5435 for Node, and `replica.ts` clones that primary with `TEST_REPLICA_CONTAINER=durable-node-replica TEST_REPLICA_PORT=5434`. Both refuse an existing container instead of deleting it. Remove only the exact containers you created, including their replicas; never prune the shared Docker daemon. Without `TEST_DATABASE_URL` or Docker the replica bootstrap prints nothing; with `CI` set, the script fails instead.

## Node runtime evidence

`bun run test:node` launches Vitest with Node rather than Bun, runs every core Postgres conformance shard, checks client error reporting, durable routing, compression compatibility and kernel-lock refusal/recovery, and runs the installed-tarball quickstart on Node, including a file-backed PGlite process restart and injected failures before and after commit. `verify:local`'s `node-postgres` check runs the `test:node:conformance` shards and `test:node:units`, and `pack` runs both tarball quickstarts. `check:ci` runs the Node and Bun tarball quickstarts before parallel checks, so packing cannot race Turbo's builds, then runs `test:node:core` and the Turbo checks concurrently through `.github/src/verify.ts`, with a separate primary and replica for each runtime. Checks run in owned process groups: failure or interruption terminates the sibling and its test-worker descendants; `--affected` is forwarded only to Turbo. Node 24+ is required; verification uses Node 26.7.0. The separate actor subprocess crash drills retain their Bun runner and are not claimed as Node crash evidence; the fleet-maintainer core case and PGlite kernel-lock subprocess cases run on Node too.

## Check layout and cache boundaries

Lint, typecheck, unit tests and builds run independently across workspaces. Only tasks consuming build artifacts wait for builds. Typechecks and typed lint use transit dependencies: dependency source changes invalidate downstream checks without serializing their execution. Task-level inputs exclude documentation; root TypeScript configuration, lint plugins, Vitest configuration, and the `.github` verification sources are included in their owning checks. The real-Turbo regression test exercises these invalidation boundaries. `verify:local` runs the whole graph on the exact head rather than `--affected`, and lowers Turbo's concurrency to `LOCAL_VERIFY_CONCURRENCY` (default 6), because suites with 15-second test timeouts fail spuriously when the shared Mac is saturated.

File-scoped type-aware lint exceptions are limited to platform boundaries: `packages/react/src` holds React hooks, whose effects and event handlers are Promise code and whose exports are React APIs, not pipeable Effect functions, so `async-function` and `missing-pipeable-signature` are off there. All other rules still run on these files.

## Checks and what they cover

- `self-host`: builds and boots both self-host runtime images through the Compose recipe (host Docker).
- `static`: `check:static` (directives, structure, format, `typecheck:ci`, the verify-runner, release-version, release-gate and branch-policy tests), then Turbo `lint lint:root typecheck` across every workspace.
- `pack`: `check:pack` (pack check and the tarball quickstart on Node and Bun).
- `workspaces`: Turbo `build test test:integration` for the public CLI, clients, cloud API contract and tooling, with a Postgres server and replica.
- `framework-unit`: the framework's `test` script minus the PGlite conformance file.
- `framework-pglite`: `packages/akter/vitest.pglite.config.ts` runs `testing/conformance/pglite/backend.test.ts` once per conformance project group; the last group lists only negated projects, so a shard added to the registry runs there until someone assigns it.
- `framework-postgres`, `framework-migrations`, `node-postgres`: the Postgres conformance shards on Bun and on Node, each group on a fresh server and replica; the Neki migration file, whose SIGKILL-at-every-boundary case is one sequential test of about three minutes, runs alone.
- `framework-drills`: the Docker failover and restore drills, alone, since they own containers and ports (host Docker).
- `sandbox`: the isolation canary above.
- `branch`: the issue-linked branch policy against `main`, a head containing its base, and the fetched head equal to the verified commit.

To rebalance, move a project between the groups in `tooling/local-verify/manifest.json`; the project names are the keys of `shards` in `packages/akter/src/testing/conformance/postgres/shards.ts`, plus `conformance` for the groups no shard names and `integration`. The manifest test fails on a project that registry does not define.

## Dependabot and Bun catalogs

Dependabot supports `package-ecosystem: bun` ([official announcement](https://github.blog/changelog/2025-02-13-dependabot-version-updates-now-support-the-bun-package-manager-ga/)). However the current [Bun parser](https://github.com/dependabot/dependabot-core/blob/main/bun/lib/dependabot/bun/file_parser.rb#L163-L185) explicitly skips `catalog:` entries; [its parser test](https://github.com/dependabot/dependabot-core/blob/main/bun/spec/dependabot/bun/file_parser_spec.rb#L67-L93) verifies that skip. It does not traverse workspaces.catalog/catalogs. Do not claim catalogs are covered by Dependabot.

Equivalent local update adapter:

```sh
bun .github/src/update-catalogs.ts package.json          # registry-backed report, no writes
bun .github/src/update-catalogs.ts package.json --write  # local manifest + Bun lock update
```

The adapter uses standard `npm view` registry metadata, updates default/named Bun catalogs, and excludes majors/downgrades/prereleases. Effect, TS/native and Oxlint are a coupled cohort: changes are held for explicit compatibility work. Prerelease pins never silently promote, even to stable. Test updates with `bun run check`, build, and provider typecheck before review. No publishing or automatic merge is included.

Dependabot version updates are turned off for this repository (there is no `dependabot.yml`); dependency updates, catalog or not, are local commands; there is no GitHub Amp plugin or webhook/scheduled dispatch to orbs. Dependabot security updates are enabled in the repository settings, so GitHub's dynamic `Dependabot Updates` and `Dependency Graph` workflows still run on `main`; they open `dependabot/*` pull requests, which are verified locally like any other (the branch policy admits only `dependabot[bot]` on a `dependabot/` branch).

### Compatibility pins (2026-09-20 audit)

- Effect and its adapters are on the stable `4.0.0`; Effect's `unstable/*` modules graduated to `effect/<area>` (for example `effect/sql`, `effect/http-api`). Vitest 5 matches the adapter's peer range.
- Drizzle ORM and Kit use the matching `rc5` snapshot `1.0.0-rc.5-5935859`; this is an intentional prerelease channel, not a stable-version claim.
- Oxlint/plugins stay at `1.82.0` with `oxlint-tsgolint` `7.0.2001`. `@effect/tsgo` `0.45.0` rejects the newer Oxlint patch target; update this cohort together when supported.
- Oxlint's `RuleTester` requires Node >=22 and rejects Bun. Its package test script uses `npm exec --package=node@26.7.0` and prints the selected version, so verification runs do not depend on the machine's default Node. This requires npm and registry access on a cold npm cache; it installs only into npm's cache, not the repository or global toolchain. Use `npm exec`, not `npx`, which Bun rewrites to `bun x` in package scripts. The vendored anti-slop rule files run through Node's test runner, not Vitest. Directive tests and application tests still run on Bun. No tests or evidence checks are skipped.
- Local verification and Compose use PostgreSQL 18.6. Orb setup installs PostgreSQL 18 from the official PGDG repository. Compose mounts the v18 image at `/var/lib/postgresql`, using a separate `postgres18` volume; orbs use `.local/postgres18`. Older volumes/directories are preserved, not migrated or deleted. Existing development data needs an explicit dump/restore or reviewed major-version upgrade before reuse.

Frozen installation, the Effect compiler patch, and full workspace checks are required after changing these pins.

Vercel OIDC authentication has been exercised in GitHub Actions. Pin action refs to reviewed immutable revisions before enabling in a sensitive repository; current version tags are conventional bootstrap refs.

An `AMP_TOKEN` secret alone does not enable issue replies or pull request reviews.
This repository does not define an Amp mention or review workflow. Those behaviors
require a separately configured integration; the verification and evidence workflows
do not invoke Amp.
