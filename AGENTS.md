# Akter agent guide

Read this file before changing code or documentation.

## Source of truth

- `docs/vision/` defines product intent.
- `docs/contracts/` defines runtime guarantees.
- `docs/architecture/` defines internal design.
- `docs/api/` defines public developer interfaces.
- `docs/verification/` defines evidence required before claiming support.
- Hosted-platform code, research and deployment infrastructure live in the private Akter Cloud repository; they do not define the framework contract.

If these conflict, stop and record an ADR. Do not silently choose the easiest interpretation.

## Branch authority (`rewrite/0.2`)

On `rewrite/0.2`, ADRs 0124–0137 in `docs/decisions/` and the contracts whose status line reads "proposal (0.2)" define the target. The 0.1 code still on the branch is being replaced milestone by milestone (E1–E8); where it disagrees with a 0.2 contract, the contract is the target and the code is not evidence of support. A contract is promoted, and its status line changes, when the failure evidence of its milestone lands. A 0.1 test or conformance group is deleted only when a 0.2 contract restates its guarantee with a test that rejects the same wrong implementation, or an accepted 0.2 ADR removes the behavior; the deleting change names which. `main` stays on 0.1, with its own contracts, until the swap.

## Repository model

This is a Bun/Turbo monorepo based on `rika-labs/monorepo-project-template`.

- The framework is `packages/akter`, published as `@rikalabs/akter`; it imports no other workspace package. The 0.2 engine is rewritten in place there; there is no side-by-side `packages/engine`.
- Other reusable code belongs in `packages/*` as `@akter/<directory>`.
- This public repository contains the framework (with its Effect client), the CLI, the public cloud API contract, tooling and framework documentation. The React and Python clients are deferred from 0.2.0 and return only through their own ADRs.
- The CLI belongs in `apps/cli`; cloud client commands (`login`, `logout`, `whoami`, `deploy`) remain public, as do the framework's operator commands (`inspect`, `log`, `snapshot`, `fork`, `replay`, `storage check`). There is no `migrate` or `adopt` command. Cloud operator commands and integration tests live with the private platform.
- The CLI (`apps/cli`) is built with Effect's `effect/cli` module. Every command, including hosted ones such as `login` and `deploy`, uses it; do not add another argument parser or CLI framework.
- Hosted infrastructure, the API, edge, console, marketing site and cloud-only packages belong in the private Akter Cloud repository, which consumes the published npm packages (`@rikalabs/akter`, `@rikalabs/akter-cli` and the cloud API contract) and does not mount this repository as a submodule.
- Tooling belongs in `tooling/*`.
- Effect is the runtime foundation; do not create a separate Effect package.
- The only client is the Effect client exported from `@rikalabs/akter` (`X.client(id)`, `X.find`), over one RPC group at `/rpc`; there is no Promise facade or second runtime. The root entry imports no store, cluster or SQL module, so contracts can be shared with browser code.
- Naming and folder rules are in `docs/architecture/repository-structure.md`; deviations go in `tooling/structure/src/exemptions.ts`.

## Engineering rules

- Read the owning contract before implementation.
- Keep actions synchronous and deterministic: no I/O, no sleep, no clock, randomness or ids except through the action context. I/O belongs in jobs. Publish nothing (replies, events, views, sends, job starts) before the shard's segment is durable.
- Never treat process memory, TypeScript types, or a lease alone as authority. Write authority is the shard's create-once segment chain (the epoch); speculative in-memory state is never authority and never published.
- Add a failure test for every durable transition.
- Update the contract, ADR, API docs, and verification when behavior changes.
- No inline `//` or `/* */` comments in code. A reason the code cannot show goes in the JSDoc of the enclosing declaration; only functional directives (lint, TypeScript, coverage, bundler) and license headers are exempt. `akter/no-inline-comments` enforces this.
- JSDoc states the reason in place and never cites an ADR, decision, research pick, or ledger entry; decision records link to code, not the reverse. `akter/no-decision-references` enforces this.

## Pull requests

Keep the description short, about 15 lines: what changed, why, the risk, and how it was verified. The template in `.github/pull_request_template.md` has these four headings. Link evidence instead of pasting it, and put long reasoning in the code, a contract or a decision record.

## Verification

Use the repository commands in `package.json`. Evidence for concurrency, fencing, ownership, durability and recovery is the seeded simulator plus the real bucket protocol: MinIO in CI and the chosen object-storage provider nightly. Simulator, filesystem or MinIO results are not provider results; do not claim provider behavior without provider-specific evidence, and Neki is historical, not a backend.

- Prefer a small set of integration/E2E scenarios through the real public API and storage. Exercise discarded actions (declared failure, defect, `PageMiss`, lost segment), interruption, retry, restart, stale and lost epochs, ambiguous appends, interrupted checkpoints and page uploads, replay, GC and fork races, and denied access where relevant; assert the resulting state and obligations, not just successful execution.
- Before adding a test, name the plausible wrong implementation it must reject. Derive expected values independently; use asymmetric inputs and both sides of important boundaries.
- Keep focused type, algebraic, protocol and packaging tests when integration/E2E cannot establish that contract. Do not mock the boundary whose behavior the test claims to prove.
- Consolidate fixtures and duplicate scenarios first. Delete a behavioral test only after identifying surviving evidence that rejects the same mistake; preserve distinct provider and failure-path evidence. On `rewrite/0.2`, a 0.1 suite retires only under the branch-authority rule above, with its dated evidence kept as history; never delete a failing 0.2 test because old source disappeared.
- Never weaken assertions, hide failures, skip cases, or change production behavior merely to make tests green. An intentional contract change needs independently justified expectations. Missing evidence is unknown, not a pass; test counts and coverage percentages are not the objective.
