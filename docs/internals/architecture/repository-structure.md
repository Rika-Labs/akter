# Repository structure

This is a Bun/Turbo monorepo. Production code in `packages/akter` imports no other workspace package; dependency direction is applications to packages, never the reverse.

```text
apps/cli/          @rikalabs/akter-cli; Effect CLI, operators, dev, cloud client
apps/self-host/    private example server and bucket-only Compose recipe
packages/akter/   @rikalabs/akter; framework rewritten in place
packages/cloud-api/ public hosted HTTP schemas, bundled in CLI cloud-api entry
tooling/conformance/ unpublished protocol and failure suites
tooling/oxlint/    repository and deterministic-handler rules
tooling/structure/ tree checker and explicit exemptions
docs/             framework vision, contracts, design, API, operations, evidence
.github/src/      CI, package, and release verification
```

## Framework entries

The source manifest currently has four public entries: `.` for browser-safe contracts and Effect handles, `./server` for serving and store adapters, `./client` for `AkterClient.layer`, and `./testing` for `Simulation`. `X.toLayer` binds handlers; `X.client` and `X.find` reach the engine through the `Client` service. The separate client transport entry is part of the same Effect client, not a second facade.

The root imports no store, SQL, Cluster, or runtime module. The S3 SDK belongs only to the server path and is excluded from filesystem-only bundles. No side-by-side engine package, React package, or Python client remains.

## Naming and boundaries

Reusable packages use `@akter/<directory>` except the published framework and CLI. Folders and files use kebab-case responsibilities, not generic `utils`, `shared`, or `common` buckets. `index.ts` is a package or subpath entry with explicit exports. Tests are colocated as `x.test.ts`; deviations need a live entry in `tooling/structure/src/exemptions.ts`.

The CLI uses `effect/cli` for every command. Hosted infrastructure, edge, console, billing, and cloud operator tooling live in the private Akter Cloud repository, which consumes published packages. It never mounts this repository as a submodule.

`bun run lint:structure` checks these boundaries. `pack:check` verifies compiled public exports and dependencies; `pack:smoke` installs a clean consumer and exercises HTTP and WebSocket on Bun and Node.
