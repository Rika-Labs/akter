# Competitive and adjacent systems

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| System | What it already does | Implication for us |
|---|---|---|
| Rivet Actors | Actor platform, private SQL, lifecycle/realtime, Effect integration | Closest direct competitor; Effect syntax alone is not a moat |
| Cloudflare Durable Objects | Provider-integrated stateful execution/storage/alarms/connections | Strong operational integration; we cannot claim equal maturity from composition alone |
| Orleans | Virtual grain identity and pluggable persistence | Actor-private SQLite is one model, not a requirement of actors |
| Dapr Actors | Virtual actors with transactional shared state-store contract | Useful comparison for state/turn semantics and operations |
| Akka persistence | Typed actor/event or durable state patterns and journals | Rich prior art; our contribution is developer product/integration |
| Temporal | Durable workflow/activity execution | Prefer integration for finite procedures, not a clone |
| Effect Cluster directly | Typed entities, routing and message storage | Our value must exceed merely renaming Entity as Actor |
| Electric / PowerSync | Data synchronization with different authority assumptions | Useful components/ideas, not turnkey authoritative-actor CDC |
| Materialize / Debezium | Query maintenance/CDC infrastructure | Evidence that automatic projections are a substantial engineering domain |
| Effect Agent / OpenCode | Agent execution and application patterns | Future agent package must solve an actual user gap; not first scope |

## Defensible initial differentiation hypothesis

A small Effect-native API with explicit receipt recovery, per-actor relational ownership and good debugging could reduce glue for existing Effect teams. Optional database projections can preserve local ownership while enabling SQL reads, but they add operational complexity and eventual consistency. Validate that customers value this enough to pay instead of using Rivet, Cloudflare or Cluster directly.

## What not to claim

Not 'the first durable actors', not 'all the same guarantees as Durable Objects', not 'millions of actors for free', and not 'better than Rivet because Layers'. Public claims should be supported by comparable workload evidence and documented constraints.

## Design-partner comparison

Implement the same small domain-control workflow using direct Effect Cluster, our wrapper and one established platform. Count application code, failure recovery steps, required infrastructure, cold/hot latency and cost under the same workload. Ask the team which debugging/operations experience they would choose. This is more informative than a broad feature checklist.

## Sources and evidence

- [C01: Rivet actor documentation](https://rivet.dev/docs/actors) — Closest general actor platform; current feature claims must come from docs, not blanket superiority claims.
- [C02: Rivet Effect SDK](https://rivet.dev/changelog/2026-06-16-introducing-the-effect-sdk/) — Effect integration means Effect-native alone is not differentiation.
- [C04: Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) — Runtime-owned identity/storage/lifecycle; use for architectural comparison.
- [C07: Orleans persistence](https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence) — Pluggable grain state, not inherently a private SQL database per entity.
- [C08: Dapr actors](https://docs.dapr.io/developing-applications/building-blocks/actors/actors-overview) — Virtual identity, activation and shared transactional actor state store.
- [C09: Akka persistence plugins](https://doc.akka.io/libraries/akka-core/current/persistence-journals.html) — Journal/snapshot persistence architecture; licensing/release policy separate assessment.
- [C10: Temporal durable execution](https://docs.temporal.io/workflows) — Procedure replay/activity orchestration, not automatic actor-local SQL semantics.
- [C11: Effect Agent](https://effect-agent.com/) — Future agent competitor; do not implement agent package during actor bootstrapping.
- [Q03: Electric Shapes](https://electric-sql.com/docs/guides/shapes) — PostgreSQL data distribution/filtering; not automatic capture from authoritative actor databases.
- [Q04: PowerSync architecture](https://docs.powersync.com/architecture/overview) — Backend-authoritative sync and client upload model; different authority direction from source actor databases.
- [Q06: Materialize documentation](https://materialize.com/docs/) — Incremental views are a substantial specialized query engine; do not quietly implement one inside ProjectionActor.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
