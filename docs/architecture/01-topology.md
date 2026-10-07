# System topology

**Responsibility:** map logical runtime responsibilities.  
**Authority:** design.  
**Owner role:** runtime architecture.
**Change policy:** a change that alters a contract guarantee requires an ADR.

The runtime is Effect Cluster sharding backed by a deployment's Postgres database. `Actors.layer` from `@rikalabs/akter/runtime` assembles topology, database, turn, entity, workflow, connection, job, event, schedule, and serialization internals. `shardGroup` controls compute placement; every durable row remains tenant-scoped in the deployment database. Hosted regional routing is a separate service concern and is not certified by the OSS one-host launch evidence. The runtime wraps Cluster's runner storage so a shard acquired while a lock refresh is in flight is not mistaken for a lost lock; the next refresh that asks about the shard checks it.

There are three run modes:

- **Embedded:** an application provides `Actors.layer` and calls actor handles as Effects.
- **Served:** the same runtime is exposed with `Actors.serve`, providing HTTP, WebSocket, SSE, and `/openapi.json`.
- **Hosted:** an external service can operate the served runtime; its provider, database, and regional behavior require their own evidence.

`Actor.make` is the only actor constructor. Named and minted actors are placed by sharding. `key: Actor.singleton` uses `Sharding.registerSingleton`, so `X.get()` and the singleton's background loop have one live owner across runners. Cron ticks are outbox timers any runner's relay may claim, and don't depend on which runner owns the singleton ([ADR 0021](../decisions/0021-multi-runner-relay-singleton-and-cron.md)). Each Cluster shard group runs in the availability zone of its Neki shard primary.

Activations are disposable. `policy.hibernateAfter` permits sleep; parked connections stay with the transport of the runner that accepted them (the holder), and the next frame or a new open wakes the actor on whichever runner owns it. Anything that makes the actor broadcast (a command, intent, timer, subscription event, or frame) wakes it first, and the broadcast goes from that activation to each holder; after an ungraceful owner death, holders resync their connections in place ([ADR 0023](../decisions/0023-connections-parking-and-streams.md)). Fibers forked in the activation `Scope` are interrupted on sleep. Process memory is never durable authority.

`Actors.layer` defaults to one embedded runner. Provide `Runner.socket({ address, listenAddress, transport })` from `@rikalabs/akter/runtime` for multiple processes, and use `Runner.mtls` to authenticate and encrypt the peer transport. The launch claim is three Bun processes on one host sharing a Postgres database; separate hosts and hosting providers need their own reachability and failure evidence. `Topology.single`, `Topology.http`, `Topology.fromConfig`, and `Topology.k8s` are not exported public APIs.

See [lifecycle](02-lifecycle.md), [dispatch](04-dispatch.md), and [deployment](../operations/01-deployment.md).
