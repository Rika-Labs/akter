# System topology

**Responsibility:** map logical runtime responsibilities.  
**Authority:** design.  
**Owner role:** runtime architecture.
**Change policy:** a change that alters a contract guarantee requires an ADR.

The runtime is Effect Cluster sharding backed by one Postgres database per deployment. `Actors.layer` from `durable-actors/runtime` assembles topology, database, turn, entity, workflow, connection, effect, event, cron, and serialization internals. `shardGroup` controls compute placement; every durable row remains tenant-scoped in the deployment database.

There are three run modes:

- **Embedded:** an application provides `Actors.layer` and calls actor handles as Effects. The control-plane actors in `packages/deployments` run this way inside `apps/api`.
- **Served:** the same runtime is exposed with `Actor.serve`, providing HTTP, WebSocket, SSE, and `/openapi.json`.
- **Hosted:** our runners provide the served runtime behind `apps/edge`; Neki is the hosted database detail.

`Actor.make` is the only actor constructor. Named and minted actors are placed by sharding. `singleton: true` uses `Sharding.registerSingleton`, so `X.get()`, cluster-wide `Cron.every`, and `run` have one live owner across runners.

Activations are disposable. `Hibernate.after` permits sleep; `Connections.park` leaves sockets at the edge and wakes the actor on the next frame. A `run` fiber is forked in the activation `Scope` on wake and interrupted on sleep or park. Process memory and `vars` are never durable authority.

The intended topology API is `Topology.single()` for a single runner and `Topology.http({ listen, advertise })` for networked runners, with `Topology.fromConfig()` for configuration. `Topology.k8s` was removed from the agreed surface; it is not an available fallback. Railway deployment is gated on a reachable per-replica `railnet0` advertise address. A service-per-runner alternative needs its own reachability and failover evidence before multi-runner support is claimed.

See [lifecycle](02-lifecycle.md), [dispatch](04-dispatch.md), and [deployment](../operations/01-deployment.md).
