# Public APIs

**Responsibility:** index the API documents and their public compatibility surface.  
**Authority:** normative API design.  
**Owner role:** API/SDK.  
**Change policy:** breaking changes require protocol/version review and migration guidance.

- [Server API](01-server-api.md)
- [Context capabilities](02-context.md)
- [TypeScript SDK](03-typescript-sdk.md)
- [Drizzle integration](04-drizzle.md)
- [Generated contracts](generated-contracts.md)
- [Naming](naming.md)
- [Versioning](versioning.md)

The framework is one `durable-actors` distribution with four entries: `.`, `/runtime`, `/client`, and `/testing`. The root owns declarations and served composition; runtime construction is `Actors.layer` from `/runtime`; browsers use `/client`; tests use `ActorTest` from `/testing`.

`ActorTest.layer({ as })` runs the real turn, serialization, and storage path. A bound actor exposes inspection, raw-row seeding, a System-caller workflow handle, turn and effect controls, and fault injection. `test.create(X)` binds minted actors. PGlite provides the fast default; Postgres covers lock-sensitive conformance cases.
