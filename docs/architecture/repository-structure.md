# Repository structure

**Responsibility:** define the public framework repository's layout and package ownership boundaries.
**Authority:** design. **Owner role:** runtime architecture.

The hosted Akter Cloud implementation is maintained separately in a private repository. This tree contains the framework, public clients, CLI, public cloud API contract and shared tooling. Framework rules for the private repository are maintained there; cloud-only decisions are private.

## Tree

```text
apps/
  cli/                      akter            the `akter` bin: local development, inspection, repair and cloud client commands
packages/
  akter/                    @rikalabs/akter  the framework; published with browser-safe, runtime and testing entries
  cloud-api/                @akter/cloud-api public Akter Cloud HTTP contract and Schema types
  react/                    @akter/react     React hooks over @rikalabs/akter/client
  python-client/            @akter/python-client  Python client generated from the served OpenAPI document
tooling/
  oxlint/                   @akter/oxlint    anti-slop rules, directives and runtime-import checks
  structure/                @akter/structure tree checker and its exemptions
docs/                       framework API, contracts, architecture, guides and verification
.github/src/                public CI, release, policy and package verification helpers
```

Dependency direction is `apps → packages → nothing app-ward`. `packages/akter` imports no workspace package. `packages/cloud-api` is a public contract only; its hosted implementation and consumers live in Akter Cloud.

## The framework package

`@rikalabs/akter` ships one distribution with four subpath entries: `.` (`src/index.ts`), `./client`, `./runtime` and `./testing`. The root and `client/` entries never import SQL or cluster modules; `runtime/` and `testing/` do. `X.toLayer` and `X.get` reach the runtime only through the `Actors` tag. Folders under `src/` are named for the responsibility they own; the source tree, not this page, lists them.

## Naming contract

- Package name is `@akter/<directory basename>`, except the framework in `packages/akter`, which is `@rikalabs/akter`.
- Folders are kebab-case nouns with one responsibility. Forbidden: `core shared common utils helpers lib misc domain types internal`.
- Files are kebab-case and named for an operation or role (`create.ts`, `contract.ts`, `layer.ts`, `queries.ts`, `schema.ts`).
- `index.ts` exists only as a package or subpath entry and names real files; wildcard exports are forbidden.
- Unit and integration tests are `x.test.ts` beside `src/x.ts`, one test file per source module. Browser E2E is not part of this public repository.
- Every deviation is one entry in `tooling/structure/src/exemptions.ts` with a reason; an entry that matches nothing fails the check.

The oxlint rules in `tooling/oxlint` check names, runtime-import boundaries, decision references and inline comments. The tree checker in `tooling/structure` owns package names, dependency direction, explicit exports, index placement and colocated tests.

## Public CLI and cloud contract

`apps/cli` publishes the unscoped `akter` bin, built with Effect's `effect/cli` module. It supports local development, deployment checks, adoption, operator inspection and repair, and the public cloud client commands `login`, `logout`, `whoami`, `env` and `deploy`. Cloud operator commands such as billing catalog setup and tenant-directory creation belong to the private platform.

`packages/cloud-api` defines the public HTTP contract used by those client commands and by the hosted console. It does not contain the hosted service implementation.

## Ways to run

- **Embedded:** an application provides `Actors.layer` from `@rikalabs/akter/runtime` and calls actors as Effects.
- **Served:** `Actors.serve` runs in its own process; a customer's BYO runner is a served container.
- **Hosted:** Akter Cloud runs the same framework behind its private API and edge services. Hosted deployment, billing, metering, databases and UI are not public workspace packages.

## Verification and release

The workspace resolves the framework entries to TypeScript sources during development. `bun run --cwd packages/akter build` emits `dist/`, `publishConfig` points the tarball's exports and types there, `.github/src/pack.ts` stages and checks the tarball, and the release workflow publishes it on a `v<version>` tag. Public CI tests with a Postgres server 18.6 where the framework's integration suites require one.
