# ADR 0134: Removing owned tables, adoption, blobs, content, placement and subscriptions

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** record which 0.1 features 0.2.0 removes without a direct replacement API, what replaces each need, and that their 0.1 evidence retires with them.

**Owner role:** runtime architecture.

## Context

0.1 lets actors own Drizzle tables, adopt existing tables with observe-then-enforce, store blobs and tenant-scoped content, place actors by tenant, actor, parent or authority, protect actor rows with optional row-level security, and subscribe to other actors' events ([ADR 0033](0033-parent-actor-placement.md), [ADR 0034](0034-tenant-scoped-content-addressed-blobs.md), [ADR 0044](0044-blob-entry-quota-and-deletion.md), [ADR 0051](0051-row-level-security.md), [ADR 0054](0054-existing-schema-adoption.md), [ADR 0026](0026-cross-actor-event-subscriptions.md)). Every one of these assumes actor data in the application's Postgres database. In 0.2 actor data lives in the store's bucket ([ADR 0124](0124-engine-rewrite-and-command-log.md)), actions cannot run SQL ([ADR 0125](0125-synchronous-deterministic-actions.md)), and there is no database to adopt or protect.

## Decision

| Removed                                                                                 | Need it served                              | 0.2 replacement                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Actor.table`, owned tables, SQL inside handlers                                        | growing or queryable actor data             | `Actor.list` fields ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)); `find` over top-level scalars ([ADR 0131](0131-find-over-owner-held-index.md)) |
| Adoption (`Actor.table(existing, { owner })`, observe-then-enforce)                     | bring existing relational data under actors | none in 0.2.0; applications import data through actions or jobs                                                                                            |
| `Actor.blob`, `turn.blob`, entry quotas                                                 | binary values per actor                     | list items holding bytes; large files are a later feature                                                                                                  |
| `Actor.content`, `Content.upload`, `Content.grant`                                      | shared immutable content                    | content-addressed pages are an engine detail with no public API                                                                                            |
| Placement (`placement`, parent placement, authority placement, routing keys, `c1.` ids) | locality and single-shard hot paths         | the shard is `hash(tenant, type, id) mod shards`; locality is not an API                                                                                   |
| Optional row-level security for actor data                                              | tenant isolation in the database            | the store's credentials isolate stores (I8a); the engine isolates tenants inside a store (I8b) ([contract 10](../contracts/10-security.md))                |
| Subscriptions (`Actor.subscription`)                                                    | react to another actor's changes            | the source action sends to interested actors with `ctx.send` ([ADR 0128](0128-constrained-actor-api.md))                                                   |
| `X.create`, `createdBy`, `NotCreated`, `Actor.singleton`                                | creation gating, singletons                 | an actor exists once it has a durable action; a singleton is a well-known id                                                                               |

Their 0.1 conformance groups (adoption, fleet, subscriptions, placement, cold tier, RLS, blobs, content) retire with the code under [ADR 0124](0124-engine-rewrite-and-command-log.md) §5; their evidence pages stay as dated history.

## Supersedes and amends

- Supersedes [ADR 0033](0033-parent-actor-placement.md) — scope: in full.
- Supersedes [ADR 0034](0034-tenant-scoped-content-addressed-blobs.md) — scope: in full.
- Supersedes [ADR 0044](0044-blob-entry-quota-and-deletion.md) — scope: in full.
- Supersedes [ADR 0051](0051-row-level-security.md) — scope: RLS as actor-data authority; control-plane database isolation is a Cloud concern.
- Supersedes [ADR 0054](0054-existing-schema-adoption.md) — scope: in full.
- Supersedes [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) — scope: per-type placement keys and the framework routing key.
- Supersedes [ADR 0017](0017-m1-record-corrections.md) — scope: `placement: "tenant" | "actor"`.
- Supersedes [ADR 0112](0112-postgres-and-pglite-only.md) — scope: generic routing keys and logical authority placement.
- Supersedes [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) — scope: §5 placement-group reads.
- Amends [ADR 0014](0014-adoption-observation-and-client-reach.md): adoption is not a 0.2 differentiator.
- Amends [ADR 0050](0050-operator-authority-and-audited-repair.md): table repair actions end; operator actions are restated in [ADR 0137](0137-inspection-audited-operations-telemetry.md).
- Amends [ADR 0109](0109-self-host-recipe.md): self-hosted 0.1 databases are not carried forward.

ADR 0097 is already superseded by ADR 0112 and is not superseded again.

## Alternatives

- **Keep owned tables beside the log.** Rejected: SQL inside actions breaks determinism, and a second store breaks the one-dependency rule (D18).
- **Port adoption to lists.** Rejected: adoption's value was controlling an existing database; without the database there is nothing to adopt.
- **Keep placement as a hint.** Rejected: it would leak into ids and storage keys without a measured need.
- **Keep subscriptions.** Rejected: they needed durable event cursors and fan-out machinery; a send from the source action is one mechanism.

## Consequences

- Applications that used these features rewrite that part of their model; 0.2 is a clean break (D5).
- Akter Cloud's control plane, which uses owned tables and authority placement, stays on 0.1 through the preview (D19).
- About 31,000 lines of conformance tests retire with their code.

## Evidence

| Milestone | Evidence                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | Negative packaging and type tests: the removed exports and definition sections do not exist                                                  |
| E4        | I8a and I8b suites replace the RLS and placement isolation suites (wrong-store credential, cross-tenant action, view, send, `find` and fork) |

## Revisit when

- A product need for relational queries over actor data returns (a query service over pages, not SQL in actions).
- Large binary values need first-class support (files).
