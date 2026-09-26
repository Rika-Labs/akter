# Durable Actors agent guide

Read this file before changing code or documentation.

## Source of truth

- `docs/vision/` defines product intent.
- `docs/contracts/` defines runtime guarantees.
- `docs/architecture/` defines internal design.
- `docs/api/` defines public developer interfaces.
- `docs/verification/` defines evidence required before claiming support.
- `research/` is supporting research, not an implementation override.

If these conflict, stop and record an ADR. Do not silently choose the easiest interpretation.

## Repository model

This is a Bun/Turbo monorepo based on `rika-labs/monorepo-project-template`.

- The framework is `packages/durable-actors`, published as `@durable-actors/core`; it imports no other workspace package.
- Other reusable code belongs in `packages/*` as `@durable-actors/<directory>`.
- Deployable processes and the CLI belong in `apps/*`.
- Runnable examples belong in `examples/*`; they are the end-to-end corpus.
- Infrastructure belongs in `infra/`.
- Tooling belongs in `tooling/*`.
- Effect is the runtime foundation; do not create a separate Effect package.
- The ordinary TypeScript SDK is `@durable-actors/core/client`, a derived surface, not a second runtime.
- Naming and folder rules are in `docs/architecture/repository-structure.md`; deviations go in `tooling/structure/src/exemptions.ts`.

## Engineering rules

- Read the owning contract before implementation.
- Keep actor turns short and transaction-bound.
- Never treat process memory, TypeScript types, or a lease alone as authority.
- Add a failure test for every durable transition.
- Update the contract, ADR, API docs, and verification when behavior changes.
- Code comments and JSDoc state the reason in place and never cite an ADR, decision, research pick, or ledger entry; decision records link to code, not the reverse. `durable-actors/no-decision-references` and `.amp/rules/quality/47-no-decision-references-in-code.md` enforce this.

## Verification

Use the repository commands in `package.json`. Prefer real Postgres for concurrency, fencing, ownership, and recovery tests. Do not claim Neki or provider behavior without provider-specific evidence.
