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

- Reusable runtime code belongs in `packages/*`.
- Deployable processes belong in `apps/*`.
- Infrastructure belongs in `infra/`.
- Tooling belongs in `tooling/*`.
- Effect is the runtime foundation; do not create a separate Effect package.
- The ordinary TypeScript SDK is a derived client surface, not a second runtime.

## Engineering rules

- Read the owning contract before implementation.
- Keep actor turns short and transaction-bound.
- Never treat process memory, TypeScript types, or a lease alone as authority.
- Add a failure test for every durable transition.
- Update the contract, ADR, API docs, and verification when behavior changes.

## Verification

Use the repository commands in `package.json`. Prefer real Postgres for concurrency, fencing, ownership, and recovery tests. Do not claim Neki or provider behavior without provider-specific evidence.
