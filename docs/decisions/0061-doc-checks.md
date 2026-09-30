# ADR 0061: Doc checks: typechecked examples and repository links

**Status:** accepted (2026-09-30).

**Responsibility:** decide how the repository proves that its documentation's code examples compile and its links resolve.

**Authority:** design decision record.

**Owner role:** documentation.

**Change policy:** supersede through a new ADR.

## Context

`docs/api`, `README.md`, and `docs/vision` show TypeScript examples of the public API, and nothing compiled them. An audit ([#380](https://github.com/Rika-Labs/durable-actors/issues/380)) found examples that pass options the API does not have (`description` on `Actor.command` and `Actor.reducer`), stage intents to reducers, which `X.intents` does not offer, read `turn.caller.id`, which does not exist, and use a value as a type. The formatter had also rewritten top-level `yield*` in fragments as multiplication. The docs site ([ADR 0043](0043-docs-site.md)) checks the links of the pages it publishes, but links from contracts, decisions, vision, and package READMEs, and their heading anchors, were unchecked; one pointed at a heading that no longer existed. [Repository structure](../architecture/repository-structure.md) says a new workspace package needs an ADR.

## Decision

- **Package.** `tooling/doc-checks` is `@durable-actors/doc-checks`, a private tooling package with tests only. It depends on `@durable-actors/core`, `effect`, `@effect/platform-bun`, and `drizzle-orm` so that examples resolve the same imports an application does. No package imports it.
- **Examples.** `src/snippets.test.ts` extracts every fenced `ts` block from `README.md`, `docs/api/*.md`, and `docs/vision/*.md`, writes each as a module under the package's ignored `.cache/snippets/`, and runs the workspace's `tsc` on them with the root `tsconfig.json`. A diagnostic is reported as the document path and line. Each block is a module on its own, so it must import what it uses.
- **Hidden setup.** An HTML comment directly above a block, invisible on GitHub and the site, supplies what a short example assumes: `<!-- snippet` followed by prelude lines and `-->` prepends imports and declarations; `file=<path>` names the block's module so later blocks import it; `<!-- snippet module=<path>` defines a module that only exists for examples, such as `./room/contract.ts`; and `<!-- snippet target -->` marks an example of API that is not implemented, which is not compiled. A marker that is malformed or not directly above a `ts` block fails the test.
- **Links.** `src/links.test.ts` resolves every relative link in `README.md`, `docs/**/*.md`, and the READMEs of apps, packages, examples, tooling, and infra: the file or directory must exist, and a `#fragment` on a Markdown target must name a heading id as `Bun.markdown` generates it, which matches GitHub's. External links are not fetched.
- **When it runs.** Turbo reruns the package's tests when a checked document changes, as it does for the docs site.

## Consequences

- An example that stops compiling after an API change fails `bun run check`, naming the document and line.
- Examples of API that is not built carry `<!-- snippet target -->`; removing the marker once the API lands turns them into checked examples.
- Preludes are part of the documents: a reader of the raw Markdown sees them, and a stale prelude fails like a stale example.
