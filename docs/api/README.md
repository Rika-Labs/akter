# Public APIs

**Responsibility:** index the API documents and their public compatibility surface.  
**Authority:** normative API design.  
**Owner role:** API/SDK.  
**Change policy:** breaking changes require protocol/version review and migration guidance.

This is the accepted API design, not a claim that every interface is implemented. The [server API's foundation subset](01-server-api.md#implemented-foundation-subset) and PGlite/Postgres-backed `ActorTest` now run; the Promise client and broader member/transport APIs remain planned. See [ADR 0005](../decisions/0005-foundation-command-protocol.md), [ADR 0006](../decisions/0006-foundation-completion.md), and the bounded [conformance evidence](../verification/01-conformance.md#foundation-evidence).

- [Server API](01-server-api.md)
- [Context capabilities](02-context.md)
- [TypeScript SDK](03-typescript-sdk.md)
- [Drizzle integration](04-drizzle.md)
- [Generated contracts](generated-contracts.md)
- [Naming](naming.md)
- [Versioning](versioning.md)

The framework is one `durable-actors` distribution with four entries: `.`, `/runtime`, `/client`, and `/testing`. The root owns declarations and served composition; runtime construction is `Actors.layer` from `/runtime`; browsers use `/client`; tests use `ActorTest` from `/testing`.

The intended `ActorTest.layer({ as })` runs the real turn, serialization, and storage path. A bound actor exposes inspection, raw-row seeding, a System-caller workflow handle, turn and effect controls, and fault injection. `test.create(X)` binds minted actors. PGlite is the proposed fast default subject to Bun/DDL compatibility gates; real Postgres is required for lock-sensitive conformance cases.
