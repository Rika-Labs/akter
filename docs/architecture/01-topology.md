# System topology

**Responsibility:** map logical runtime responsibilities.  
**Authority:** design.  
**Owner role:** runtime architecture.
**Change policy:** a change that alters a contract guarantee requires an ADR.

The runtime is Effect Cluster sharding backed by one Postgres database per deployment region. A hosted deployment may span regions, each with its own database and runner pool; `apps/edge` routes each request to its tenant's home region, and singletons run in the primary region ([ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md)). `Actors.layer` from `@durable-actors/core/runtime` assembles topology, database, turn, entity, workflow, connection, effect, event, cron, and serialization internals. `shardGroup` controls compute placement; every durable row remains tenant-scoped in the deployment database. The runtime wraps Cluster's runner storage so a shard acquired while a lock refresh is in flight is not mistaken for a lost lock; the next refresh that asks about the shard checks it.

There are three run modes:

- **Embedded:** an application provides `Actors.layer` and calls actor handles as Effects. The control-plane actors in `packages/deployments` run this way inside `apps/api`.
- **Served:** the same runtime is exposed with `Actor.serve`, providing HTTP, WebSocket, SSE, and `/openapi.json`.
- **Hosted:** our runners provide the served runtime behind `apps/edge`; Neki is the hosted database detail.

`Actor.make` is the only actor constructor. Named and minted actors are placed by sharding. `key: Actor.singleton` uses `Sharding.registerSingleton`, so `X.get()` and the singleton's background loop have one live owner across runners. Cron ticks are outbox timers any runner's relay may claim, and don't depend on which runner owns the singleton ([ADR 0021](../decisions/0021-multi-runner-relay-singleton-and-cron.md)). Each Cluster shard group runs in the availability zone of its Neki shard primary.

Activations are disposable. `policy.hibernateAfter` permits sleep; parked connections stay with the transport of the runner that accepted them (the holder), and the next frame or a new open wakes the actor on whichever runner owns it. Anything that makes the actor broadcast (a command, intent, timer, subscription event, or frame) wakes it first, and the broadcast goes from that activation to each holder; after an ungraceful owner death, holders resync their connections in place ([ADR 0023](../decisions/0023-connections-parking-and-streams.md)). Fibers forked in the activation `Scope` are interrupted on sleep. Process memory is never durable authority.

The intended topology API is `Topology.single()` for a single runner and `Topology.http({ listen, advertise })` for networked runners, with `Topology.fromConfig()` for configuration. `Topology.k8s` was removed from the agreed surface; it is not an available fallback. Railway deployment is gated on a reachable per-replica `railnet0` advertise address. A service-per-runner alternative needs its own reachability and failover evidence before multi-runner support is claimed.

See [lifecycle](02-lifecycle.md), [dispatch](04-dispatch.md), and [deployment](../operations/01-deployment.md).
