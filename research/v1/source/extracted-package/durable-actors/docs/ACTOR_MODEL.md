# Choosing actor boundaries

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

An actor owns an independently consistent unit of domain state. It may own several tables, not only one row. Choose the boundary around invariants and lifecycle before choosing storage granularity.

## Examples

| Domain | Sensible initial actor | Keep together | Usually external |
|---|---|---|---|
| Domain management | Domain(hostname) | ownership, DNS validation, provisioning state | registrar API, certificate issuer |
| Deployment | Deployment(id) | stage state, logs index, retries, target revision | build workers, runtime API |
| Commerce | Order(id) | order lines, accepted total, transitions | payment provider, inventory actors |
| Collaboration | Board/workspace(id) | ordering and board-level invariants | identity provider, search projection |
| Device fleet | Device(id) | command sequence, latest confirmed state | telemetry ingestion and fleet analytics |
| Small todos | Board(id) often first | all todos if inexpensive and transactional | cross-board search |

One todo per actor is useful when individual todos have substantial independent lifecycle, but can be over-granular economically. Database count limits, startup overhead, migration fleet size and coordination fan-out count against it. Do not turn the slogan 'one entity, one actor' into one DB for every incidental record.

## Parallelism

Two commands to one actor serialize at its mutation boundary. They can both be accepted concurrently and commit in an order; this is not an inability to add two todos. Different actors run concurrently. A shared actor can become a hot key regardless of the number of machines. Partition only along boundaries where cross-partition invariants can tolerate asynchronous coordination.

## Cross-domain protocols

Order should ask Inventory to reserve a quantity with a stable reservation ID, not import InventoryRepo. Waiting on another actor while holding the order database write transaction risks locks, deadlocks and availability coupling. Stage the request and resume on a durable response for multi-step mutations. An external coordinator may perform bounded authoritative read RPCs when no local transaction is held.

## Authoritative data versus projection

Projected data is suitable for lists, search and dashboards. It is not sufficient to authorize a payment or reserve stock without consulting the authority. A projection actor is a read model, not a second owner of the underlying order or device.

## Domain correctness still matters

Serialization does not validate input, prices or transitions. Order totals use integer minor currency units and a currency code or a deliberate decimal representation—not floating numbers from a caller. Certificates have actual validity/renewal policy, not an invented 365-day constant. Payment status becomes paid only after confirmed capture, not when capture is merely scheduled. Keep such domain details in the application, with typed errors and tests.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [C07: Orleans persistence](https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-persistence) — Pluggable grain state, not inherently a private SQL database per entity.
- [C08: Dapr actors](https://docs.dapr.io/developing-applications/building-blocks/actors/actors-overview) — Virtual identity, activation and shared transactional actor state store.
