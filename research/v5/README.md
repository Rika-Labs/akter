# Research v5 — post-foundation product directions (2026-09-23)

Predecessor: [v4](../v4/README.md). v5 records the product review after M0 and converts the roadmap discussion into gated decisions. It does not claim that any proposed M6–M8 feature is implemented.

## Decisions

- [DECISIONS.md](DECISIONS.md) records the accepted direction and unresolved implementation questions.
- [SOURCES.md](SOURCES.md) records the external product and registry pages used for the competitive review.
- The normative architecture decisions are [ADR 0014](../../docs/decisions/0014-adoption-observation-and-client-reach.md), [ADR 0015](../../docs/decisions/0015-durable-agent-runtime-boundary.md), and [ADR 0016](../../docs/decisions/0016-generated-durable-applications.md).

## Evidence used

- Existing repository vision, contracts, API, operations, and verification documents.
- Rivet public documentation for Actors, agentOS, and Dynamic Apps, reviewed on 2026-09-23; see [sources](SOURCES.md).
- npm registry lookups for `durable-apps` and `durable-os`, both returning HTTP 404 / package not found at review time.

## Scope boundary

Rivet's VM/kernel and sandbox implementation are not being replicated. The proposed advantage is transactional Postgres authority, inspection, adoption, governance, and derived client reach. Sandboxes remain providers until first-party isolation is separately approved and verified.
