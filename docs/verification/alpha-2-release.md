# Alpha.2 release preparation evidence

Recorded on 2026-10-07 for `chore/664-alpha-2`. This is candidate verification, not a publication or a production upgrade rehearsal. No npm public-registry publish, tags, dist-tag changes or production deployment were performed.

This record predates [ADR 0112](../decisions/0112-postgres-and-pglite-only.md): Neki is removed, not a pending release gate. [Removal verification](neki-removal.md) records the current Postgres/PGlite-only checks.

## Environment and commands

- macOS arm64; Node `24.18.0`, npm from that Node distribution, Bun `1.4.2`.
- Isolated Postgres server: `postgres:18.6-bookworm`, container `akter-release-pg`, loopback port `55479`, with logical WAL and `pg_stat_statements` enabled. Only the container created for this verification was used.
- Long-running commands used background execution and a timeout of at least 1800 seconds. No full `check` or `check:ci` was run locally.
- Temporary validation scripts and detailed logs were kept outside the checkout and release tarballs. Those scripts are not in the repository; their procedures are described below. Local Verdaccio bound only `127.0.0.1:49179`; both alpha.2 tarballs were published there for dependency-resolution evidence, never to the public npm registry. Its process was stopped after each proof and its temporary authentication configuration was removed.

Run repository commands below from the checkout root, with the recorded Node and Bun versions on `PATH`. Replace `<staging-dir>` with a writable scratch directory outside the checkout, or under `.local/`. Install dependencies with `bun install`. Consumer-install commands in the table run in separate empty temporary directories, not in the repository's workspace. For SQL scenarios, prepare a disposable Postgres server with the recorded settings and use its connection URL.

## Package and peer-resolution gate

`bun install` regenerated the lockfile with both package versions at `0.1.0-alpha.2`. These repository commands build and validate both distributions, then create their tarballs:

```sh
bun .github/src/pack.ts --out "<staging-dir>/framework" --cli-out "<staging-dir>/cli"
npm pack --ignore-scripts --pack-destination "<staging-dir>" "<staging-dir>/framework"
npm pack --ignore-scripts --pack-destination "<staging-dir>" "<staging-dir>/cli"
```

The initial exact-peer manifests fail plain npm installation with `ERESOLVE`: a transitive `effect@^4.0.0` lookup selects `4.0.1` before the package's exact `effect@4.0.0` peer is considered. Changing peer order does not fix it. Runtime Effect dependency pins were investigated only in scratch manifests and rejected because a private Effect copy could break service/schema identity.

The local-registry installation procedure used a temporary script that is not in the repository. Start a loopback-only Verdaccio registry with an npm upstream for third-party dependencies, publish both packed alpha.2 tarballs to that registry, and set its local `latest` tags to the candidate versions for the plain-install cases. Configure npm and Bun consumers to use that registry. Create separate clean framework-only and CLI-only consumers, then separate consumers that install `effect@latest` before adding the framework and CLI. The recorded cases pass:

| Consumer                    | Commands                                                                                 | Result                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Clean npm app               | `npm i @rikalabs/akter`                                                                  | Installs successfully; one Effect copy                                                 |
| Clean npm app               | `npm i -D @rikalabs/akter-cli`                                                           | Installs CLI and framework successfully; executable help works; one Effect copy        |
| Existing npm app            | `npm i effect@latest`, then framework and CLI installs                                   | Retains compatible `effect@4.0.1`; one Effect copy                                     |
| Clean Bun app               | `bun add @rikalabs/akter`                                                                | Installs successfully; no peer mismatch; one Effect copy                               |
| Clean Bun app               | `bun add -d @rikalabs/akter-cli`                                                         | Installs CLI and framework successfully; help works; no peer mismatch; one Effect copy |
| Existing Bun app            | `bun add effect@latest`, then framework and CLI installs                                 | Retains compatible `effect@4.0.1`; no peer mismatch; one Effect copy                   |
| Exact-peer negative control | Existing `effect@latest` app adds a local-registry package with the original exact peers | Refuses with `ERESOLVE`, rather than silently nesting Effect                           |

Each successful case runs `npm ls effect --all` in its consumer directory and independently counts physical `effect/package.json` locations after resolving symlinks. Every graph contains exactly one copy. For the negative control, publish an isolated prerelease with the original exact peer declarations to the local registry, then add it to an application that already has `effect@latest`; assert that npm refuses with `ERESOLVE`. The control does not overwrite the candidate registry version. The resolved SQL drivers are `4.0.1`; the compatible Drizzle prerelease is `1.0.0-rc.5-ab785fc`. Neither `--force` nor `--legacy-peer-deps` is used.

## Runtime and CLI smoke

The repository smoke runs both staged packages in separate clean temporary projects:

```sh
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package "<staging-dir>/framework" --cli-package "<staging-dir>/cli"
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package "<staging-dir>/framework" --cli-package "<staging-dir>/cli"
```

Both pass: declaration typecheck, in-memory increments `[2,5]`, file-backed restart `[2,5]` then `[7,10]`, receipt replay and injected before/after-commit crashes, `akter --help`, offline login help, and real `akter dev` readiness, command results `[7,9]`, inspector page/asset and refusal of the old inspector route. The consumer override points the CLI's framework dependency at the same local tarball: without it, Bun tried fetching the unpublished alpha.2 version from npm and failed. The production package's exact framework dependency is unchanged.

The quickstart procedure also used a temporary script that is not in the repository. Copy the source and test files directly from `docs/quickstart.md` into clean consumer directories. Run its install commands against the local registry, selecting `@rikalabs/akter@alpha` and unversioned compatible dependencies; use the documented Node platform/test substitutions for the Node consumer. Repeat those runtime scenarios in existing Effect applications with both release packages installed through their explicit `alpha` tags. On each engine, the recorded file-backed app prints `visits: 1` then `visits: 2`, and both original tests pass. Apply the documented server-backed substitution with a dedicated database per engine/scenario and repeat the same restart, receipt and before/after-commit crash assertions. Those cases also pass. These are single-runner scenarios, not mixed-alpha upgrade or provider proofs.

The tag-selection proof deliberately sets local `alpha` to `0.1.0-alpha.2` and local `latest` to `0.1.0-alpha.2-exact.1` for both package names. The latter is an isolated manifest-only control version, not a historical release or a runtime candidate. Registry metadata confirms the tags differ; fresh npm and Bun consumers explicitly selecting `alpha` install framework and CLI version `0.1.0-alpha.2`, keep one Effect copy and pass the quickstart scenarios. This rejects instructions accidentally relying on `latest`. The public registry's `latest` can remain alpha.0 until the maintainer moves it; no public tag was changed by this proof.

Two earlier literal quickstart runs exposed documentation failures that are not hidden: explicitly pinning Effect while permitting a newer transitive platform package produced an invalid Bun peer graph, and directly installing bare `drizzle-orm` on Bun selected stable `0.45.3`, which lacks `drizzle-orm/effect-postgres`. The final instructions promise no fixed cohort and let the framework's compatible peer select Drizzle instead of requesting its incompatible `latest` tag.

The packed Node CLI ran `akter login --api-url https://akter-pr-50-api.fly.dev` and reached the real device authorization flow, printing the preview console approval URL and waiting for approval. It was intentionally interrupted with exit `130`, without browser approval, account creation or saved credentials. The device user code is redacted in the retained log. This proves initiation only, not completed login.

To repeat the initiation check, install the packed CLI in a temporary consumer and invoke its executable from the checkout root, replacing the placeholders with that consumer directory and a test preview API URL:

```sh
"<consumer-dir>/node_modules/.bin/akter" login --api-url "<preview-api-url>"
```

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

- Before tagging, replace the marked `akter logs` changelog entries with the shipped and verified behavior.
- Update the exact workspace catalog to the published `4.0.1` family through the separately verified dependency change. This candidate's range-resolution evidence does not itself change that catalog.
- CI must produce a successful Verify run for the exact final tagged commit. This document's local checks are not a replacement for that workflow gate.
- npm trusted-publisher bootstrap for the first CLI publication remains a maintainer operation; no public publish or dist-tag movement was attempted here.
- Alpha.1/alpha.2 runner overlap, a production backup/restore rehearsal, Neki/provider behavior and completed browser login are unverified. Follow the stopped-runner upgrade procedure and rehearse with the deployment's own schemas, payloads and permissions before promotion.
