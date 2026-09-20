# Requirement provenance and technical evidence

## Product requirements

- [Original thread](https://ampcode.com/threads/T-01a0b54d-b476-74c0-81bc-b3aae5ce5784): explicitly retained BlobStore, jobs, workflows, activities, local testing, and a single cross-environment runtime direction.
- [Current design thread](https://ampcode.com/threads/T-01a0ba62-7a32-702c-8a58-47980e196974): Effect/TypeScript split, public SQL state, Drizzle, unified context/database, automatic ownership, integrated realtime, deployment decisions, and final approval to include the four advanced capabilities and create research v3.
- [Archived architecture](../v1/generated/durable-actors-architecture.md): historical detailed inventory, including blobs (§3.13), background work (§3.10–12), timers (§3.9), transports/console (§7), tests (§8), and operations (§9). Its old implementation decisions are not automatically authoritative.
- [v2 assessment](../v2/README.md) and [validation gates](../v2/VALIDATION.md): technical corrections that remain in force.

## Authoritative references already consulted

These references support particular mechanisms, not proof of an unbuilt framework. Recheck versions/provider capabilities when implementing; no new provider compatibility experiment was performed for v3.

| Reference | Relevant boundary |
| --- | --- |
| [Neki query planning](https://planetscale.com/docs/neki/query-planning) | Single-shard transaction mode, cross-shard snapshot/commit limits |
| [Neki topology](https://planetscale.com/docs/neki/data-topology) | Colocation and routing |
| [Neki preview limitations](https://planetscale.com/docs/neki/platform-preview-limitations) | Validate actual supported features, not PostgreSQL protocol assumptions |
| [Postgres row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | USING/WITH CHECK, roles and bypass caveats |
| [Postgres isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | Snapshot and concurrency semantics |
| [Pinned Effect SqlClient](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/packages/effect/src/unstable/sql/SqlClient.ts) | Transaction service identity; same URL does not imply same transaction |
| [Effect SqlSchema](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.112/packages/effect/src/unstable/sql/SqlSchema.ts) | Runtime request encoding/result decoding versus SQL inference |
| [Rivet SQLite/Drizzle](https://rivet.dev/actors/docs/sqlite-drizzle/) | Reference integration; actor-local SQLite is not our shared-row model |
| [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) | Reference private-storage and transaction boundary, not our substrate |
| [Drizzle Durable Objects adapter](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do) | Adapter composition, not evidence of our Effect/Postgres bridge |
| [Original ACTOR paper](https://www.ijcai.org/Proceedings/73/Papers/027B.pdf) | Actor model origins |
| [Hewitt's later actor definition](https://www.cs.unc.edu/~stotts/COMP590-059-f21/slides/actorHewitt2010.pdf) | Message-only interaction; shared SQL observation is a deliberate extension |

## Evidence limits

No runtime, type-inference adapter, Neki enforcement policy, provider effect adapter, transfer protocol, incremental query engine, or hibernating gateway was implemented/tested in this documentation task. The feature-folder validation sections describe experiments to run, not results. The archived scaffold is historical evidence, not a working v3 SDK.
