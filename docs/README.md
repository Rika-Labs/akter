# Durable Actors documentation

This directory is the implementation-facing source of truth for Durable Actors. The [research archive](../research/README.md) contains evidence and exploration; it does not silently override these documents.

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
