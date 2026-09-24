# ADR 0017: M1 record corrections: shipped status, Outlast, state codec, and placement

**Status:** accepted (2026-09-24). Supersedes [ADR 0015](0015-durable-agent-runtime-boundary.md), ADR 0011's dictionary requirement, ADR 0013's "Not implemented" list as a status record, and the parent-actor placement option in ADR 0006 and ADR 0010's definition table as accepted API.

**Responsibility:** correct decision records that M1 planning found stale or unresolved.

**Authority:** design and product direction.

**Owner role:** runtime architecture.

**Change policy:** supersede through an ADR.

## Context

Planning M1 ([milestone](../milestones/M1.md)) found four records that no longer match the code or the product. Accepted ADRs are not edited in place, so this ADR carries the corrections.

## Decision

### ADR 0013's "Not implemented" list is stale

[ADR 0013](0013-m0-reconciliation.md) lists queries, placement, `routing_key`, and the two-round-trip path as unimplemented. Queries (`Actor.query`, `X.Read`), `placement`, and `routing_key` have since shipped in M1.1 and M1.2, and state migrations in M1.3. The two-round-trip and pipelined turn paths remain unimplemented. ADR 0013 is no longer a status record: [M1](../milestones/M1.md) tracks what is implemented, and the [conformance ledger](../verification/01-conformance.md) records the evidence.

### Outlast is a separate product; ADR 0015 is superseded

[ADR 0015](0015-durable-agent-runtime-boundary.md) planned a durable agent runtime as an adapter package inside this project. That runtime is now Outlast, a separate product in its own repository that compiles each session to an ordinary `Actor.make` and depends on the published `durable-actors` package. This repository builds no agent runtime, agent package, or sandbox provider boundary. Milestone M7 is withdrawn; framework features Outlast needs are proposed here through ordinary ADRs and scheduled in ordinary milestones. The core package stays AI-neutral.

### State uses plain zstd with a stored codec version

[ADR 0011](0011-direct-commands-outbox-and-performance.md) and contract 06 required zstd with a per-actor-type dictionary. The shipped codec compresses each value as one plain zstd frame with no dictionary. Dictionaries need training data, versioned distribution, and a dictionary id per row, which is not justified before measurements show a size problem.

[Contract 06](../contracts/06-storage-ownership.md) now requires plain zstd with a codec version. Codec version 1 is one zstd frame without a dictionary. Current rows need no version marker and no rewrite: `actor_state.value` has been `bytea` only since `0003_routing_state`, and every row since then was written without a dictionary, so each decodes with plain zstd decompression. The first change that adds a second codec must add a per-row codec version in its own migration, with existing rows defaulting to 1, and must keep decoding version 1.

### `placement: "tenant" | "actor"` is the accepted API

[ADR 0006](0006-scale-rules-placement-and-query-tiers.md) left the placement-key API to compatibility review. `Actor.make(name, { placement })` accepts `"tenant"` (the default) or `"actor"`, as shipped in M1.1; the placement and its encoding version are recorded per actor type, and changing either is refused at startup. Placing an actor with a parent actor stays target API and needs its own design before it ships.

## Evidence

- `packages/durable-actors/src/runtime/storage/codec.ts` compresses with `Bun.zstdCompressSync` and no dictionary.
- `packages/durable-actors/src/runtime/database/migrations.ts`: `0003_routing_state` creates `actor_state.value bytea` and `actor_placements (actor_type, placement, encoding)` with `placement IN ('tenant', 'actor')`.
- `refuses to start an actor type under a different placement than its stored rows` in `packages/durable-actors/src/runtime/database/pglite.test.ts`.
- M1.1–M1.3 shipped in PRs #18, #19, and #25; their cases are listed in the [conformance ledger](../verification/01-conformance.md).

## Alternatives

- **Edit ADR 0013 and ADR 0015 in place:** rejected; accepted ADRs are immutable.
- **Ship per-type dictionaries now:** rejected until measurements show that plain zstd leaves a real size problem.
- **Keep M7 as a thin Outlast-support milestone:** rejected; Outlast's needs are ordinary framework features and go through ordinary ADRs.

## Consequences

- The vision, positioning, API sketches, and milestone index no longer promise an agent runtime package in this repository.
- A future dictionary or other codec is a data migration with a stored per-row version, not a silent codec change.

## Revisit when

- State size measurements show that dictionaries would materially reduce storage or I/O.
- An application needs parent-actor placement.
