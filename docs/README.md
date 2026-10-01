# Akter documentation

**Responsibility:** index the documentation and its authority order.  
**Authority:** documentation policy.  
**Owner role:** documentation.  
**Change policy:** keep the authority order accurate when directories change.

This directory is the implementation-facing source of truth for Akter. The settled v4 design has been incorporated into these specifications; the [research archive](../research/README.md) retains evidence and exploration.

These specifications describe accepted design; only part of it has shipped. The root, `/runtime`, and `/testing` entrypoints implement M0 and M1.1–M1.3 (see [M1](milestones/M1.md)); `/client` is still a scaffold. [ADR 0002](decisions/0002-v4-contract-clarifications.md) reconciles the v4 contracts; [ADR 0003](decisions/0003-failure-scoping-drain-and-hosted-trust.md) resolves declared-failure rollback, automatic adapter scoping, bounded drain, and hosted trust. [ADR 0004](decisions/0004-receipt-access-revocation-and-expiry.md) settles receipt access, revocation, and command expiry. Executable support is tracked in the [support matrix](operations/support-matrix.md).

Start with the [quickstart](quickstart.md) to run an actor app.

## Authority order

1. `vision/` — product intent and boundaries.
2. `contracts/` — externally observable runtime guarantees.
3. `architecture/` — internal design required to satisfy the contracts.
4. `api/` — public API shape and compatibility rules.
5. `operations/` — deployment and operator responsibilities.
6. `verification/` — evidence required before claiming support.
7. `decisions/` — historical rationale for accepted choices.
8. `milestones/` — current implementation scope and sequencing.

If documents conflict, stop and create an ADR before coding. Do not resolve a contract conflict by silently choosing the easier implementation.

## Settled framework surface

The framework is one `@rikalabs/akter` distribution with root, `/runtime`, `/client`, and `/testing` entries. `Actor.make` is the only actor constructor, `Actors.layer` constructs the runtime, `Actors.serve` exposes HTTP, WebSocket, SSE, and OpenAPI, and `ActorTest` exercises the real turn path.

Actors run embedded, served, or hosted. One database serves each deployment region; tenants are rows and placement is selected by shard group. See [Public APIs](api/README.md), [Repository structure](architecture/repository-structure.md), and the [Glossary](GLOSSARY.md).

The gates in [v4 verification](../research/v4/DECISIONS.md#4-verification-gates-must-pass-before-the-decision-is-claimed) remain evidence requirements until their checks pass. In particular, Neki transaction and locking behavior, Railway advertise addresses, PGlite compatibility, multi-runner recovery, workflow isolation, connection parking, and singleton uniqueness must not be claimed from design alone.

## Document responsibility

Every normative document has these fields at the top:

- **Responsibility:** the decision area it owns.
- **Authority:** `normative`, `design`, `operational`, or `evidence`.
- **Owner role:** the role responsible for keeping it correct.
- **Change policy:** what must change with it.

The owner role is a responsibility, not a person. The current agent or maintainer assumes it while editing.

## Directories

| Directory                              | Responsibility                              | Owner role           |
| -------------------------------------- | ------------------------------------------- | -------------------- |
| [vision](vision/README.md)             | Why the product exists and its boundaries   | Product              |
| [contracts](contracts/README.md)       | What the runtime must guarantee             | Runtime architecture |
| [architecture](architecture/README.md) | How the system can provide those guarantees | Runtime architecture |
| [api](api/README.md)                   | What application developers import and call | API / SDK            |
| [operations](operations/README.md)     | How customers run and recover it            | Operations           |
| [verification](verification/README.md) | What evidence is required                   | Verification         |
| [decisions](decisions/README.md)       | Why important choices were made             | Architecture         |
| [milestones](milestones/README.md)     | What is being built now                     | Delivery             |
