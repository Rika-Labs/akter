# Start here

## Read in this order

1. [DECISIONS_SUMMARY.md](DECISIONS_SUMMARY.md): selected, conditional, deferred and rejected choices.
2. [docs/VISION.md](docs/VISION.md) and [docs/V1_SCOPE.md](docs/V1_SCOPE.md): what to build and what not to build.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DURABILITY.md](docs/DURABILITY.md): the real correctness boundary.
4. [docs/API_DESIGN.md](docs/API_DESIGN.md), [docs/PROGRAMMING_MODEL.md](docs/PROGRAMMING_MODEL.md), and [docs/INTERFACES.md](docs/INTERFACES.md): proposed public contracts.
5. [docs/MONOREPO.md](docs/MONOREPO.md), [docs/BUN_NODE_COMPATIBILITY.md](docs/BUN_NODE_COMPATIBILITY.md), and [docs/CI_CD.md](docs/CI_CD.md): how the codebase is organized.
6. [docs/VALIDATION_GATES.md](docs/VALIDATION_GATES.md) and [docs/IMPLEMENTATION_BACKLOG.md](docs/IMPLEMENTATION_BACKLOG.md): the first engineering work.
7. [docs/COST_MODEL.md](docs/COST_MODEL.md), [docs/PRICING.md](docs/PRICING.md), and [docs/CLOUD_ARCHITECTURE.md](docs/CLOUD_ARCHITECTURE.md): how to turn a tested runtime into a hosted business.

## First work, not first marketing claim

Prove a single command can commit an actor-local mutation plus receipt and survive a runner death before PostgreSQL records the reply. Re-deliver the same command and recover the original result without repeating the mutation. Then prove a stale owner cannot write after successor fence installation. Do this against the exact remote libSQL endpoint intended for production, not just local SQLite.

Only after these tests pass should you implement the attractive `Actor.make` interface around them.

## Run the skeleton

Install the Bun version declared in `.bun-version` and Node 24 for compatibility tools. Run:

```sh
bun install
bun run setup:toolchain
bun run check:scaffold
bun run typecheck
bun run test
bun run build
bun dev
```

A command failing because a pinned release is unavailable or a diagnostics patch is incompatible is a real compatibility failure. Do not silently downgrade the toolchain. The generated [VALIDATION.md](VALIDATION.md) records what succeeded in this environment and what remains untested.

## What the files mean

- `packages/*/src`: contract-only source boundaries, no actor runtime implementation.
- `packages/*/test`: mirrored test tree; existing tests validate the scaffold/import surface, not durability.
- `specs/`: proposed interfaces, reference SQL and failure scenarios. SQL here is a design artifact, not an automatic migration.
- `apps/docs`: a small static Vite portal for this package.
- `apps/runner`, `apps/gateway`, `apps/relay`: deployment boundaries with README/placeholder entries, not working services.
- `infra/`: provider configuration templates and an intentionally non-provisioning Alchemy entry.
- `research/`: source registry, support evidence, research matrix, gaps and retrieval metadata.
- `models/`: a reproducible hypothetical unit-economics model; no revenue forecast.

## Scope of this deliverable

No repository was created on GitHub, no npm package published, no cloud resource provisioned, and no provider contract negotiated. This archive is designed for review and implementation planning.

## Concrete next steps

Read [Execution order](docs/EXECUTION_ORDER.md), [corrections](docs/SAFETY_AND_SCOPE_CORRECTIONS.md), and [actual validation results](VALIDATION.md) before coding.
