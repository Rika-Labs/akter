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
- [The `akter` CLI](06-cli.md)
- [Customer runner logs](07-cloud-logs.md)
- [Cloud usage and pricing](08-cloud-usage.md)
- [Environment API keys](09-environment-api-keys.md)
- [Generated contracts](generated-contracts.md)
- [Naming](naming.md)
- [Versioning](versioning.md)
- [Post-foundation API sketches](post-foundation-sketches.md) — illustrative proposals, not implemented interfaces

The framework is one `@rikalabs/akter` distribution with four entries: `.`, `/runtime`, `/client`, and `/testing`. The root owns declarations and served composition; runtime construction is `Actors.layer` from `/runtime`; browsers use `/client`; tests use `ActorTest` from `/testing`.

`ActorTest.layer({ as })` runs the real turn, serialization, and storage path. A bound actor exposes inspection, raw-row seeding, a System-caller handle, turn and job controls, and fault injection. In-memory PGlite is the default database; a real Postgres server is required for lock-sensitive tests. `/testing` also supplies database fixtures, cleanup/content sweeps, and `checkBatchLaw`. The framework's conformance corpus, multi-runner harness, and deterministic simulations live in the unpublished [`tooling/conformance` workspace](../../tooling/conformance/README.md), not the app-developer API.
