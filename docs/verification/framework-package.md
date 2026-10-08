# Framework package boundary and dependency cohort

Evidence recorded on 2026-10-08 for [ADR 0111](../decisions/0111-framework-verification-workspace.md). This is repository/package evidence, not certification of a provider or production deployment.

The measurements and commands below precede the stacked [Neki removal](neki-removal.md). Its provider tests and separate migration project have since been removed; they remain here only as the package-split baseline.

## Packed size

Both measurements used `bun .github/src/pack.ts --out <temporary-directory>` followed by `npm pack --dry-run --json --ignore-scripts <temporary-directory>`, on the same alpha.2 framework manifest.

| Framework tarball          | Unpacked bytes | Files | Compressed bytes |
| -------------------------- | -------------: | ----: | ---------------: |
| Before the workspace split |      6,476,175 |   615 |        1,117,414 |
| After the workspace split  |      2,494,508 |   411 |          639,092 |

The unpacked package shrank by 3,981,667 bytes (61.5%) and 204 files. The private `@akter/conformance` workspace owns the relocated fixtures, suites, cluster harness, simulations and Vitest configurations. The public testing entry retains `ActorTest`, database fixtures, cleanup/content sweeps, `checkBatchLaw` and fault controls. No runtime imports connect the package back to that workspace. The pack guard rejects compiled conformance, foundation, cluster and simulation modules, with a regression test that still accepts the public testing entry.

## Dependency and consumer checks

The catalog pins Effect and its platform/SQL/Vitest cohort to 4.0.2, and Vitest to 5.0.3. The staged framework manifest resolves Effect peer ranges to `^4.0.2`, which accept patch 4.0.2; the internal platform-node-shared runtime dependency remains exactly 4.0.2. Tarball smoke installs into a clean consumer, typechecks its public API, exercises memory and file-backed database commands/restarts, and checks the CLI.

Verification uses Bun 1.4.2, Node 26.10.0 and a disposable Postgres 18.6 server with logical WAL. An initial run on the orb's older Bun 1.3.10 failed TLS and Unicode HTTP cases; rerunning those exact cases on the repository-required Bun 1.4.2 passed without production changes. Those initial failures are not counted as passes.

| Command                                                                                                                                            | Result                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                                                                                                                                | Passed across nine workspaces and CI sources.                                                                                                                                       |
| `bun run lint`                                                                                                                                     | Passed, including directives and structure.                                                                                                                                         |
| `bun --bun node_modules/vitest/vitest.mjs run .github/src/release/manifest.test.ts .github/src/verify.test.ts`                                     | 14 tests passed.                                                                                                                                                                    |
| `bun run test`                                                                                                                                     | All nine workspace tasks passed (seven cached); framework 331 tests passed, private conformance 637 passed and 247 capability-gated skips.                                          |
| `bun run --cwd tooling/conformance test:pglite`                                                                                                    | 22 files passed, 3 skipped; 593 tests passed, 246 skipped for unsupported PGlite capabilities.                                                                                      |
| `TEST_DATABASE_URL=<disposable-postgres> bun run --cwd tooling/conformance test:integration:postgres --project=!integration:migrations`            | 54 files passed, 1 skipped; 933 tests passed and 859 skips, including the unconfigured Neki corpus and streaming-replica gates.                                                     |
| `TEST_DATABASE_URL=<disposable-postgres> bun run --cwd tooling/conformance test:integration:postgres --project=integration:migrations -t Postgres` | 11 tests passed, 3 real-Neki gates skipped. The suite name matches Postgres, so this also ran the local autocommit protocol's crash/upgrade walks, not merely plain-Postgres cases. |
| `bun run format:check`                                                                                                                             | Passed across the repository.                                                                                                                                                       |
| `bun run pack:smoke --package <staged-directory>` and `SMOKE_RUNTIME=node bun run pack:smoke --package <staged-directory>`                         | Clean consumer typecheck, memory commands, persisted restart, receipt replay, before/after-commit faults and CLI smoke passed on both Bun and Node.                                 |

Real Neki, streaming-replica and Docker-drill evidence is separate from the packaging boundary. No real Neki or replica target was configured, and Docker drills were not run in this package-split check. Missing target configuration yields skips, not a support claim.
