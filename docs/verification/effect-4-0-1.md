# Effect 4.0.1 cohort verification

This is historical dependency evidence. The [package split](framework-package.md) upgrades the cohort to 4.0.2; [ADR 0112](../decisions/0112-postgres-and-pglite-only.md) removes Neki rather than leaving its former gates pending. See [removal verification](neki-removal.md) for current Postgres/PGlite-only checks.

Recorded on 2026-10-07 for `chore/664-effect-4-0-x`, stacked on the alpha.2 release preparation. The registry reports `4.0.1` as the newest jointly published 4.0.x patch for `effect`, `@effect/platform-bun`, `@effect/platform-node-shared`, `@effect/platform-node`, `@effect/sql-pg`, `@effect/sql-pglite` and `@effect/vitest`.

Only those seven exact catalog pins and their lockfile records change. Runtime dependencies remain exact; the release-preparation change's published-peer caret ranges now have the new catalog floors. Drizzle, PGlite, TypeScript, Vitest and the separately versioned `@effect/tsgo` tool are not bumped. The cloud repository and submodule pointer are untouched; their catalog alignment requires a subsequent submodule update.

## Commands and results

All builds, typechecks and test suites ran in background with a timeout of at least 1800 seconds. The engines were Node `24.18.0`, npm `11.16.0` and Bun `1.4.2` on macOS arm64. SQL cases used an isolated Postgres server `18.6` at loopback port `55479`, container `akter-release-pg`; each test created its own disposable database where required.

Run the commands below from the checkout root with the recorded runtime versions on `PATH`, after `bun install`. Replace `<staging-dir>` with a writable scratch directory outside the checkout, or under `.local/`, and `<database-url>` with a connection URL for a disposable Postgres server. The registry metadata command's `<package>` placeholder names each of the seven packages listed above.

- `npm view "<package>@4.0.1" version peerDependencies dependencies --json`, for all seven cohort packages, confirms each exists and their Effect peers accept `^4.0.1`. `@effect/vitest@4.0.1` accepts the unchanged Vitest `5.0.1` catalog pin.
- `bun install` regenerates the lockfile; `bun install --frozen-lockfile` passes without changes.
- `bun run typecheck:ci`, `bun run --cwd packages/akter typecheck`, `bun run --cwd apps/cli typecheck` and `bun run --cwd packages/cloud-api typecheck` pass. `bun run lint:structure`, changed-file formatting and `git diff --check` pass.
- `bun --bun node_modules/vitest/vitest.mjs run .github/src/release/manifest.test.ts .github/src/release/version.test.ts .github/src/release/notes.test.ts` passes all existing and release-policy assertions.
- `bun run --cwd apps/cli build:inspector` builds the browser client.
- The focused Bun HTTP/SQL/platform suite passes:

```sh
TEST_DATABASE_URL="<database-url>" bun --bun node_modules/vitest/vitest.mjs run \
  packages/akter/src/runtime/storage/platform.test.ts \
  packages/akter/src/runtime/database/pglite.test.ts \
  packages/akter/src/runtime/database/migrations.test.ts \
  packages/akter/src/runtime/database/bounded.test.ts \
  packages/akter/src/serve/auth.test.ts \
  packages/akter/src/serve/wire.test.ts \
  packages/akter/src/serve/sessions/sse.test.ts \
  apps/cli/src/commands/dev/run.test.ts \
  apps/cli/src/commands/cloud/login.test.ts \
  apps/cli/src/commands/cloud/env.test.ts \
  apps/cli/src/commands/cloud/deploy.test.ts
```

- The focused Node suite also passes against the same isolated server:

```sh
TEST_DATABASE_URL="<database-url>" node node_modules/vitest/vitest.mjs run \
  packages/akter/src/runtime/storage/platform.test.ts \
  packages/akter/src/runtime/database/bounded.test.ts \
  packages/akter/src/serve/auth.test.ts \
  packages/akter/src/serve/wire.test.ts
```

- The package build and both runtime smokes pass clean-consumer declaration checking, persistent increments, receipt/crash assertions and the real CLI development server, readiness, commands and inspector assets:

```sh
bun .github/src/pack.ts --out "<staging-dir>/framework" --cli-out "<staging-dir>/cli"
SMOKE_RUNTIME=node bun .github/src/release/smoke.ts --package "<staging-dir>/framework" --cli-package "<staging-dir>/cli"
SMOKE_RUNTIME=bun bun .github/src/release/smoke.ts --package "<staging-dir>/framework" --cli-package "<staging-dir>/cli"
```

No behavior change was observed in these scenarios, and no tests, assertions, timeouts or production code were changed to make them pass. Detailed logs and registry metadata were retained outside the repository.

## Limits and release obligations

Focused local evidence does not replace Verify for the final release commit. The full local `check` and `check:ci` were not run; CI owns the remaining suites. Separate-host, mixed-alpha, Neki/provider and production restore/deployment claims are unchanged and not established here. No public publication, tags, public dist-tag changes or production writes were performed.
