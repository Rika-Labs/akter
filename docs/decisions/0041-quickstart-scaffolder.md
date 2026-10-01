# ADR 0041: The quickstart scaffolder and its PGlite default

**Status:** superseded (2026-10-01, Dallen): the scaffolder was removed before the first release, and the [quickstart](../quickstart.md) installs `@rikalabs/akter` directly. Accepted 2026-09-28.

**Responsibility:** decide how `bun create @akter` is packaged, what it generates, and what its PGlite default promises.

**Authority:** design decision record.

**Owner role:** API / SDK.

**Change policy:** supersede through a new ADR.

## Context

CR.2 ([#86](https://github.com/Rika-Labs/akter/issues/86)) needs an empty-directory-to-running-app path with no Docker. `bun create <scope>` runs the bin of the npm package `<scope>/create`. [ADR 0029](0029-licence-package-name-and-release-policy.md) says the scaffolder publishes when it ships and that published packages declare exact peers; [ADR 0040](0040-trusted-publishing-release-path.md) says each new package's first version is bootstrapped by hand. Neither the scaffolder nor `@rikalabs/akter` is on npm yet.

## Decision

- **Package.** `packages/create` is `@akter/create` with one bin, `create-akter`. It stays `private: true` until the CR.1b release ([#99](https://github.com/Rika-Labs/akter/issues/99)) drops the flag, adds the ADR 0029 manifest fields, and bootstraps its trusted publisher. It ships TypeScript sources run by Bun, not compiled modules, because Bun is required to run the generated app anyway; CR.1b may compile it.
- **Templates.** `counter` (the default) and `chat` are complete apps copied from `packages/create/templates/`. The scaffolder writes `package.json` with the exact versions of `@rikalabs/akter`, its peer dependencies, `@effect/platform-bun`, `@types/bun`, and TypeScript; a unit test fails when those drift from the workspace catalog or the core version. It refuses a non-empty target directory.
- **Database.** A generated app uses `Database.postgres` when `DATABASE_URL` is set and otherwise `Database.pglite({ dataDir })` with `DATA_DIR` defaulting to `./.data`. Nothing else changes between backends.
- **Promise.** File-backed PGlite in a generated app is for development and one process per data directory. It is not a production backend and not evidence for locking, independent connections, multi-runner behaviour, or process-kill recovery; production PGlite is gated on M4.14. Superseded by [ADR 0035](0035-pglite-embedded-production-backend.md), which M4.14 built: a generated app on file-backed PGlite is a supported production shape for one process per data directory, within that ADR's limits.
- **Evidence.** `bun .github/src/release/quickstart.ts` (the `@akter/create` `test:integration` task) stages and packs `@rikalabs/akter`, packs the scaffolder, installs the scaffolder from its tarball, generates both templates into a temporary directory, points `@rikalabs/akter` at the local tarball instead of npm, installs, typechecks, and runs each app's own tests and two `bun start` runs on PGlite and on a fresh Postgres database. It requires `TEST_DATABASE_URL` in CI.

## Alternatives

- **A `create-akter` unscoped package.** Needs a second npm name outside the scope for no gain; `bun create @akter` already resolves to `@akter/create`.
- **Generate from `examples/`.** Examples are workspace packages wired to the monorepo's Vitest and `catalog:` versions; templates must install and test standalone.
- **PGlite in memory by default.** Would lose state between runs and hide the durable restart the quickstart demonstrates.

## Consequences

- A template change must keep its generated tests passing on both backends, which the CI smoke enforces.
- Until CR.1b, the quickstart runs from a checkout with a locally packed core tarball.

## Revisit when

- CR.1b publishes the scaffolder, or M4.14 settles production PGlite.
