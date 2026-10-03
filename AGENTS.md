# Akter agent guide

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

- The framework is `packages/akter`, published as `@rikalabs/akter`; it imports no other workspace package.
- Other reusable code belongs in `packages/*` as `@akter/<directory>`.
- Deployable processes and the CLI belong in `apps/*`.
- The CLI (`apps/cli`) is built with Effect's `effect/cli` module. Every command, including hosted ones such as `login` and `deploy`, uses it; do not add another argument parser or CLI framework.
- Infrastructure belongs in `infra/`.
- Tooling belongs in `tooling/*`.
- Effect is the runtime foundation; do not create a separate Effect package.
- The ordinary TypeScript SDK is `@rikalabs/akter/client`, a derived surface, not a second runtime.
- Naming and folder rules are in `docs/architecture/repository-structure.md`; deviations go in `tooling/structure/src/exemptions.ts`.

## Engineering rules

- Read the owning contract before implementation.
- Keep actor turns short and transaction-bound.
- Never treat process memory, TypeScript types, or a lease alone as authority.
- Add a failure test for every durable transition.
- Update the contract, ADR, API docs, and verification when behavior changes.
- No inline `//` or `/* */` comments in code. A reason the code cannot show goes in the JSDoc of the enclosing declaration; only functional directives (lint, TypeScript, coverage, bundler) and license headers are exempt. `akter/no-inline-comments` enforces this.
- JSDoc states the reason in place and never cites an ADR, decision, research pick, or ledger entry; decision records link to code, not the reverse. `akter/no-decision-references` enforces this.

## Verification

Use the repository commands in `package.json`. Prefer real Postgres for concurrency, fencing, ownership, and recovery tests. Do not claim Neki or provider behavior without provider-specific evidence.

- Prefer a small set of integration/E2E scenarios through the real public API and storage. Exercise rollback, interruption, retry, restart, stale ownership and denied access where relevant; assert the resulting state and obligations, not just successful execution.
- Before adding a test, name the plausible wrong implementation it must reject. Derive expected values independently; use asymmetric inputs and both sides of important boundaries.
- Keep focused type, algebraic, protocol and packaging tests when integration/E2E cannot establish that contract. Do not mock the boundary whose behavior the test claims to prove.
- Consolidate fixtures and duplicate scenarios first. Delete a behavioral test only after identifying surviving evidence that rejects the same mistake; preserve distinct provider and failure-path evidence.
- Never weaken assertions, hide failures, skip cases, or change production behavior merely to make tests green. An intentional contract change needs independently justified expectations. Missing evidence is unknown, not a pass; test counts and coverage percentages are not the objective.
