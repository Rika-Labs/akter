# Public APIs

**Responsibility:** index the API documents and their public compatibility surface.  
**Authority:** normative API design.  
**Owner role:** API/SDK.  
**Change policy:** breaking changes require protocol/version review and migration guidance.

This is the accepted API design, not a claim that every interface is implemented. [ADR 0010](../decisions/0010-one-way-effect-native-api.md) defines its shape: one way to make an actor, one way to call it, and one typed context service per phase. The [server API's foundation subset](01-server-api.md#implemented-foundation-subset) and PGlite/Postgres-backed `ActorTest` now run; the Promise client serves commands, queries, optimistic reducers, event feeds, streams, and connections ([implemented subset](03-typescript-sdk.md#implemented-subset-m34)); `Fleet` and the sketches below remain planned. See [ADR 0007](../decisions/0007-foundation-command-protocol.md), [ADR 0008](../decisions/0008-foundation-completion.md), and the bounded conformance evidence.

- [Server API](01-server-api.md)
- [Context capabilities](02-context.md)
- [TypeScript SDK](03-typescript-sdk.md)
- [Drizzle integration](04-drizzle.md)
- [Generating clients](05-generated-clients.md)
- [The `durable` CLI](06-cli.md)
- [The Akter Cloud API](07-cloud-api.md)
- [Generated contracts](generated-contracts.md)
- [Naming](naming.md)
- [Versioning](versioning.md)
- [Post-foundation API sketches](post-foundation-sketches.md) — illustrative proposals, not implemented interfaces

The framework is one `@rikalabs/akter` distribution with four entries: `.`, `/runtime`, `/client`, and `/testing`. The root owns declarations and served composition; runtime construction is `Actors.layer` from `/runtime`; browsers use `/client`; tests use `ActorTest` from `/testing`.

`ActorTest.layer({ as })` runs the real turn, serialization, and storage path. A bound actor exposes inspection, raw-row seeding, a System-caller handle, turn and job controls, and fault injection. `ActorTest.simulate({ seed, faults }, program)` runs deterministic simulation: each `simulation.command(label, call, { relays })` gets a minted command id and a seeded fault (`crashBeforeCommit`, `crashAfterCommit`, `dropReply`, `clockSkew`, and `relayCrash` for `relays` commands), and the run then settles the outbox and checks at least one command, one receipt per command, no due or attempted outbox row left (future timers stay), and every fault reached; a rerun of a seed repeats labels, faults, and skews, while command ids are minted fresh, dying with the seed on any violation. `simulationSeeds` reads `SIMULATION_SEEDS` and `SIMULATION_SEED_BASE`. `ActorTest.simulateCluster({ seed, faults, ... }, program)` does the same on an `ActorTest.cluster` with `runnerKill`, `heartbeatLoss`, `connectionLoss`, and `primaryFailover` beside the crash and dropped-reply faults, and `clusterSimulationSeeds` reads `CLUSTER_SIMULATION_SEEDS` and `SIMULATION_SEED_BASE`. In-memory PGlite is the default database; real Postgres is required for lock-sensitive conformance cases, which are reported skipped on PGlite.
