# Alpha.2 release preparation evidence

Recorded on 2026-10-07 for `chore/664-alpha-2`. This is candidate verification, not a publication or a production upgrade rehearsal. No npm public-registry publish, tags, dist-tag changes or production deployment were performed.

## Environment and commands

- macOS arm64; Node `24.18.0`, npm from that Node distribution, Bun `1.4.2`.
- Isolated Postgres server: `postgres:18.6-bookworm`, container `akter-release-pg`, loopback port `55479`, with logical WAL and `pg_stat_statements` enabled. Only this stream's container is used.
- Heavy commands run through `~/.capy/work/akter-launch/heavy.sh` with background execution and a timeout of at least 1800 seconds. No full `check` or `check:ci` was run locally.
- Scratch scripts and detailed logs are in `~/.capy/work/akter-launch/alpha-2/`, not in the release tarballs. Local Verdaccio binds only `127.0.0.1:49179`; both alpha.2 tarballs are published there for dependency-resolution evidence, never to the public npm registry. Its process is stopped after each proof and its temporary authentication configuration is removed.

The runtime selection for the commands below is:

```sh
export PATH="$HOME/.capy/work/akter-launch/alpha-2/bin:$HOME/.capy/work/akter-launch/alpha-2/node-v24.18.0-darwin-arm64/bin:$PATH"
```

## Package and peer-resolution gate

`bun install` regenerated the lockfile with both package versions at `0.1.0-alpha.2`. `bun .github/src/pack.ts --out "$HOME/.capy/work/akter-launch/alpha-2/package" --cli-out "$HOME/.capy/work/akter-launch/alpha-2/package-cli"` builds and validates both distributions. `npm pack --ignore-scripts` creates the tarballs from those staged directories.

The initial exact-peer manifests fail plain npm installation with `ERESOLVE`: a transitive `effect@^4.0.0` lookup selects `4.0.1` before the package's exact `effect@4.0.0` peer is considered. Changing peer order does not fix it. Runtime Effect dependency pins were investigated only in scratch manifests and rejected because a private Effect copy could break service/schema identity.

`heavy.sh python3 "$HOME/.capy/work/akter-launch/alpha-2/registry-proof.py"` passes these real local-registry cases:

| Consumer                    | Commands                                                                                 | Result                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Clean npm app               | `npm i @rikalabs/akter`                                                                  | Installs successfully; one Effect copy                                                 |
| Clean npm app               | `npm i -D @rikalabs/akter-cli`                                                           | Installs CLI and framework successfully; executable help works; one Effect copy        |
| Existing npm app            | `npm i effect@latest`, then framework and CLI installs                                   | Retains compatible `effect@4.0.1`; one Effect copy                                     |
| Clean Bun app               | `bun add @rikalabs/akter`                                                                | Installs successfully; no peer mismatch; one Effect copy                               |
| Clean Bun app               | `bun add -d @rikalabs/akter-cli`                                                         | Installs CLI and framework successfully; help works; no peer mismatch; one Effect copy |
| Existing Bun app            | `bun add effect@latest`, then framework and CLI installs                                 | Retains compatible `effect@4.0.1`; no peer mismatch; one Effect copy                   |
| Exact-peer negative control | Existing `effect@latest` app adds a local-registry package with the original exact peers | Refuses with `ERESOLVE`, rather than silently nesting Effect                           |

Each successful case runs `npm ls effect --all` and independently counts physical `effect/package.json` locations after resolving symlinks. Every graph contains exactly one copy. The negative control uses an isolated prerelease version with the original exact peer declarations, so it does not overwrite the candidate registry version. The resolved SQL drivers are `4.0.1`; the compatible Drizzle prerelease is `1.0.0-rc.5-ab785fc`. Neither `--force` nor `--legacy-peer-deps` is used.

## Runtime and CLI smoke

The repository smoke runs both staged packages in separate clean temporary projects:

```sh
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package "$HOME/.capy/work/akter-launch/alpha-2/package" --cli-package "$HOME/.capy/work/akter-launch/alpha-2/package-cli"
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package "$HOME/.capy/work/akter-launch/alpha-2/package" --cli-package "$HOME/.capy/work/akter-launch/alpha-2/package-cli"
```

Both pass: declaration typecheck, in-memory increments `[2,5]`, file-backed restart `[2,5]` then `[7,10]`, receipt replay and injected before/after-commit crashes, `akter --help`, offline login help, and real `akter dev` readiness, command results `[7,9]`, inspector page/asset and refusal of the old inspector route. The consumer override points the CLI's framework dependency at the same local tarball: without it, Bun tried fetching the unpublished alpha.2 version from npm and failed. The production package's exact framework dependency is unchanged.

`heavy.sh python3 "$HOME/.capy/work/akter-launch/alpha-2/quickstart-with-registry.py"` extracts the source and test files directly from `docs/quickstart.md`. It runs the documented unversioned install commands against the local registry, with the documented Node platform/test substitutions. It also repeats those runtime scenarios in existing Effect applications with both release packages installed. On each engine, the file-backed app prints `visits: 1` then `visits: 2`, and both original tests pass. The documented server-backed substitution uses a dedicated database per engine/scenario and repeats the same restart, receipt and before/after-commit crash assertions. These are single-runner scenarios, not mixed-alpha upgrade or provider proofs.

Two earlier literal quickstart runs exposed documentation failures that are not hidden: explicitly pinning Effect while permitting a newer transitive platform package produced an invalid Bun peer graph, and directly installing bare `drizzle-orm` on Bun selected stable `0.45.3`, which lacks `drizzle-orm/effect-postgres`. The final instructions promise no fixed cohort and let the framework's compatible peer select Drizzle instead of requesting its incompatible `latest` tag.

The packed Node CLI ran `akter login --api-url https://akter-pr-50-api.fly.dev` and reached the real device authorization flow, printing the preview console approval URL and waiting for approval. It was intentionally interrupted with exit `130`, without browser approval, account creation or saved credentials. The device user code is redacted in the retained log. This proves initiation only, not completed login.

## Release gate and static checks

The unchanged `release.yml` has no dry-run dispatch input. Its exact read-only **Require a successful Verify run for the tagged commit** shell step was extracted and run with `GITHUB_REPOSITORY=Rika-Labs/akter` against commit `5289b7d1535179b57bdf902b49dfa59a40b317a7`, before it had any successful Verify run. It printed `No successful Verify run found for 5289b7d1535179b57bdf902b49dfa59a40b317a7` and exited `1`. No tag or publish step was run.

Focused checks pass:

```sh
bun run typecheck:ci
GOMAXPROCS=1 bunx --bun oxlint --type-aware --deny-warnings --threads 1 .github/src/release/manifest.ts .github/src/release/manifest.test.ts .github/src/release/smoke.ts
bun --bun node_modules/vitest/vitest.mjs run .github/src/release/manifest.test.ts .github/src/release/notes.test.ts .github/src/release/version.test.ts
bun .github/src/release/version.ts
bun .github/src/release/notes.ts 0.1.0-alpha.2
bun run lint:structure
```

The packaging tests now assert compatible ranges only for the named shared-library peers, exact runtime dependencies, unchanged optional-peer metadata, no private Effect dependency and untouched source manifests. Existing assertions were retained except for the independently approved change from exact published peers to caret ranges. Formatting and `git diff --check` cover the changed files.

## Still required before tagging

- The orchestrator must finalize the clearly marked `akter logs` changelog lines after the parallel implementation merges and is verified.
- A separate Effect-cohort PR updates the exact workspace catalog to the published `4.0.1` family. This candidate's range-resolution evidence does not quietly change that catalog.
- CI must produce a successful Verify run for the exact final tagged commit. This document's local checks are not a replacement for that workflow gate.
- npm trusted-publisher bootstrap for the first CLI publication remains a maintainer operation; no public publish or dist-tag movement was attempted here.
- Alpha.1/alpha.2 runner overlap, a production backup/restore rehearsal, Neki/provider behavior and completed browser login are unverified. Follow the stopped-runner upgrade procedure and rehearse with the deployment's own schemas, payloads and permissions before promotion.
