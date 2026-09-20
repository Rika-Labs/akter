# System diagrams

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Runtime and storage roles

```mermaid
flowchart LR
  U[HTTP / CLI clients] --> G[Gateway: Auth + HttpApi]
  G --> C[Effect Cluster]
  C --> R1[Runner 1
Bun platform]
  C --> R2[Runner 2
Node compatibility]
  C --> P[(Postgres control
messages / replies / ownership)]
  R1 --> D1[(Actor A private libSQL)]
  R2 --> D2[(Actor B private libSQL)]
  D1 --> O[Recoverable intent relay]
  D2 --> O
  O --> P
  O --> Q[(Customer projection DB)]
  O --> W[Workflow bridge]
  W --> X[External systems]
  W --> C
```

## Commit and recovery sequence

```mermaid
sequenceDiagram
  participant Client
  participant PG as Postgres delivery
  participant Runner
  participant DB as Actor private DB
  Client->>PG: Persist command + stable ID
  PG-->>Client: Accepted receipt
  PG->>Runner: Deliver
  Runner->>DB: Fence + receipt check + local tx
  DB->>DB: Mutation + result + outbox commit
  DB-->>Runner: Committed
  Note over Runner,DB: Crash here must not repeat mutation
  Runner->>PG: Register recoverable intents + reply
  PG-->>Client: Retained result
```

## Projection authority

```mermaid
flowchart TD
  A[Authoritative actor rows] --> L[Local transactional change log]
  L --> Relay[Versioned ordered relay]
  Relay --> SQL[Customer-owned Postgres read model]
  Relay -. later optional .-> View[ProjectionActor private read DB]
  SQL --> Queries[Global joins / dashboards]
  View --> Subs[Named view queries / subscriptions]
```

The optional target actor does not need PostgreSQL as a mandatory intermediary. PostgreSQL-derived multi-source views are a separate feature, not implied by single-source projection routing.

## Package boundary

```mermaid
flowchart BT
  Cluster[cluster] --> Core[core contracts]
  Turso[turso] --> Core
  Projections[projections] --> Core
  HTTP[http] --> Core
  CLI[cli] --> HTTP
  CLI --> Core
  Bun[platform-bun] --> Core
  Node[platform-node] --> Core
  Testing[testing] --> Core
  App[application assembly] --> Cluster
  App --> Turso
  App --> HTTP
  App --> Projections
```

## Scope lifetime

```
logical actor identity:  -------------------------------------------->
activation A:           [ Scope + DB client + cache ]
activation B:                                         [ Scope ... ]
durable DB:             =============================================>
external workflow:                 [ named durable work ------------> ]
```

A diagram box is a responsibility boundary, not necessarily a separate microservice. Keep deployment roles together until operational evidence warrants splitting them.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
