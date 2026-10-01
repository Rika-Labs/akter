# ADR 0014: Adoption, observation, and client reach

**Status:** accepted product direction; implementation and verification gated (2026-09-23)

**Responsibility:** define the post-foundation adoption and developer-experience roadmap.

**Authority:** product and API direction.

**Owner role:** product/runtime.

**Change policy:** supersede with a new ADR when an interface or guarantee changes.

## Context

The foundation differentiates Akter through transactional actor turns over ordinary Postgres. That advantage is immaterial if adopting it requires moving an existing application into a new storage model. Rivet and Durable Objects also have stronger developer-facing inspection and client reach than the current planned surface.

The earlier sketches identified seven opportunities: existing-schema adoption, live query observation, offline command replay, workflow compatibility, inspection/export, generated protocols and language clients, and runners that can scale to zero. They are related because each extends an existing contract—ownership, receipts, events, workflow steps, or served schemas—rather than adding a second runtime.

## Decision

M2 introduces workflow compatibility together with the workflow engine; M6 will pursue the remaining capabilities in this order:

1. **Existing-schema adoption.** `Actor.table(existingTable, { owner })` may map pre-existing tenant and actor columns. A CLI migration supports observe-then-enforce guards. Direct legacy writes must be measurable and rejectable before the actor is declared authoritative.
2. **Query observation.** A declared, supported query algebra may produce invalidation notifications and rerun results after committed writes. The framework will not promise arbitrary SQL incremental view maintenance. Cross-actor and fleet queries require explicit cost and consistency tiers.
3. **Offline commands.** The Promise client may persist optimistic reducer inputs and replay the original command IDs. Expired IDs surface as conflicts; the client never silently mints replacement IDs.
4. **Workflow compatibility (M2 prerequisite).** Workflow steps have stable names and explicit version markers. Deploy tooling checks active executions before activation and refuses removal of steps still required by retained executions.
5. **Inspection and export.** Operators can inspect receipts, committed outcomes, ownership, and durable consequences, then export a supported actor seed for `ActorTest`. Historical rewind is not promised until per-turn history has a defined retention and storage cost.
6. **Generated protocols.** Public contract members may derive OpenAPI, MCP, and non-Effect clients from the same schemas. Internal commands remain absent from every public derivation. MCP tool-call identity must preserve command identity for retries.
7. **Scale-to-zero serving.** A request-scoped runner is a supported deployment target only after benchmarks quantify wake cost, state loading, due-work scanning, and parked-connection behavior. Socket gateways and durable work must not depend on a runner's process memory.

## Consequences

The framework becomes useful to brownfield Postgres applications and to browser/offline clients without weakening actor authority. Query observation is intentionally narrower than a general live-SQL engine. Inspection and export become first-class operational APIs, but an export is a reproducible seed, not an authorization bypass or an unbounded database snapshot.

M6 adds no new public mutation primitive. Adoption uses the existing table capability, offline replay uses receipts, and generated protocols use existing contract schemas. This preserves the one-way API rule.

## Alternatives rejected

- Requiring a greenfield schema migration before actor adoption: preserves implementation simplicity but removes the strongest Postgres wedge.
- Promising arbitrary SQL live queries: impossible to support honestly without a supported relational algebra, dependency tracking, and bounded invalidation cost.
- Replacing expired offline command IDs automatically: risks converting an uncertain outcome into a duplicate operation.
- Treating workflow source order as its version: makes ordinary refactors corrupt in-flight executions.
- Building a separate queue or broker product: receipts and the actor outbox already own the required semantics.

## Evidence and revisit conditions

M6 is not supported until conformance covers legacy-write guards, query invalidation scope, offline expiry, workflow deployment checks, export authorization, generated-schema parity, and cold-runner recovery. Revisit if live-query maintenance requires a separate storage engine or if scale-to-zero cannot preserve workflow and connection guarantees at the documented cost.

See [illustrative API sketches](../api/post-foundation-sketches.md) and the [research sources](../../research/v5/SOURCES.md).
