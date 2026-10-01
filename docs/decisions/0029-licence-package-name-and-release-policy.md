# ADR 0029: Licence, package name, and release policy

**Status:** accepted (2026-09-26). Dallen decided the licence, the `@akter` scope, and the alpha at M1 close; the licence covering `apps/*` is the delivery lead's default until Dallen says otherwise. It amends [ADR 0001](0001-repository-structure.md), which names the framework `akter` and lets it alone go unscoped.

**Responsibility:** decide the project licence, the framework's npm name and entries, which packages publish, and how published versions are numbered.

**Authority:** design decision record.

**Owner role:** API and release.

**Change policy:** supersede through a new ADR.

## Context

ADR 0001 settled one framework distribution named `akter` with four entries (`.`, `/runtime`, `/client`, `/testing`) and kept it `private: true`. The repository had no licence, so nobody else could use the code.

On 2026-09-26 Dallen decided to license the project under Apache-2.0 and to publish an alpha at M1 close. On 2026-10-01 the project was renamed Akter. npm refuses the unscoped name `akter` as too similar to existing packages, so the framework publishes under the `@rikalabs` scope that Rika Labs already owns. The `bun create` scaffolder was dropped before release; a React package (CR.6) may follow under the same scope.

## Decision

- **Licence.** The whole repository is Apache-2.0, copyright Rika Labs: `packages/*`, `apps/*`, `examples/*`, `tooling/*`, `infra/` and the docs. `LICENSE` and `NOTICE` sit at the root, and every published package ships both and sets `"license": "Apache-2.0"`. Vendored code keeps its upstream licence beside it (`tooling/oxlint/ANTI-SLOP-LICENSE`, `tooling/oxlint/anti-slop/vendor/*/LICENSE`), and `research/` keeps the licences of the material it archives. Licensing `apps/*` differently (for example, keeping the hosted control plane source-available only) needs a new ADR before any of it is published.
- **Framework name.** The framework package is `@rikalabs/akter`, with the same four entries: `@rikalabs/akter`, `@rikalabs/akter/runtime`, `@rikalabs/akter/client`, and `@rikalabs/akter/testing`. The browser-safety rule for the root and `/client` is unchanged.
- **Directory.** The framework stays in `packages/akter`. The naming contract forbids `core` as a folder name, and moving every framework path would conflict with every open branch for no user-visible gain. The structure checker encodes the one mapping: `packages/akter` must be named `@rikalabs/akter`, and every other package is `@akter/<directory basename>`.
- **Identifiers that aren't package specifiers.** Service keys the Effect language service derives from the module path (for example `@rikalabs/akter/handles/actors`) follow the new name. They are in-memory identifiers and are never stored. Other context keys, span names (`akter.<Actor>/<Command>`), and the `akter/*` lint rule namespace keep their spelling.
- **Published packages.** A package publishes only when an ADR or milestone names it. Today that is `@rikalabs/akter`; the scaffolder (CR.2) and `@akter/react` (CR.6) join when they ship. Every published package lives in `packages/*`, drops `private: true`, sets `license`, `repository` (with `directory`), `homepage`, `files`, `engines`, and `keywords`, and publishes compiled ES modules and declarations, not TypeScript sources. Libraries whose types or runtime identity must be shared with the application (`effect`, the Effect SQL drivers, `drizzle-orm`) are exact-version peer dependencies, so a consumer never ends up with two copies. Every other workspace package stays `private: true`.
- **Versions.** Published packages start at `0.1.0-alpha.0`. Alphas publish to the `alpha` dist-tag, never `latest`, and may change APIs and stored formats between alphas without a migration path. The first alpha supports one runner per database. Packages that ship together share a version. `0.x` releases after the alphas follow [versioning](../api/versioning.md): a minor bump may break the API, and a stored-format change still needs its compatibility review.
- **`client/` environment.** ADR 0001 asked that the `client/` TypeScript environment (no Bun or Node globals) be settled when the framework leaves `private`. The entry is still a placeholder, so M3.4, which builds the Promise client, settles it.
- **How releases happen.** CR.1b (#99) owns the publish workflow and the first publish. The framework's tarball shape and a CI dry-run pack check land with the rename, so the publish unit starts from a package that already packs cleanly.

## Alternatives

- **Keep the unscoped name.** Not available on npm.
- **`@akter/akter`.** Repeats the scope and reads as a mistake; `core` says what the package is.
- **Rename the directory to `packages/core`.** Makes the name rule uniform, but `core` is a forbidden generic folder name, and the move touches every framework path.
- **License only the published packages.** Leaves `apps/*` and `examples/*` unlicensed, so nobody can reuse the examples or self-host the control plane. Dallen can still carve out `apps/*` with a new ADR.
- **Publish TypeScript sources.** Bun can run them, but bundlers and Node type-checkers would compile the framework under each consumer's compiler settings. Compiled declarations give consumers one checked surface.

## Consequences

- Every import of the framework changes from `akter…` to `@rikalabs/akter…`, and every open branch rebases onto the rename.
- Anything exported from a published entry must emit declarations. An exported value whose inferred type names a symbol TypeScript can't reach fails the build.
- [Repository structure](../architecture/repository-structure.md), `AGENTS.md`, the API docs, and [versioning](../api/versioning.md) describe the new name and policy.

## Evidence

`bun run check` and the Postgres integration suites pass on the rename. `bun .github/src/pack.ts` builds and stages the framework, runs `npm pack --dry-run`, and checks the file list and manifest; CI runs it on every pull request.

## Revisit when

- A package outside `packages/*` needs to publish, or part of the repository needs a different licence.
- Multi-runner support is verified, so later alphas can drop the single-runner limit.
