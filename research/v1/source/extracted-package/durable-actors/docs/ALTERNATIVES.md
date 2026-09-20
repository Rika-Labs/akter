# Storage and infrastructure alternatives

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Per-actor relational database candidates

| Candidate | Potential fit | Why not selected first |
|---|---|---|
| Turso/libSQL | Managed database-per-entity, existing Effect client path | Selected conditionally; requires engine/transaction/quota contract |
| Self-hosted libSQL | Compatible SQL model with operations under user control | Managed Cloud scale/tiering/provisioning not automatically reproduced |
| Cloudflare D1 | Managed isolated SQLite-style DBs | Provider API/runtime constraints; not universal libSQL transport |
| Neon | Isolated PostgreSQL branch/project model | Different SQL/compute/provisioning granularity; better evaluated for larger tenants |
| mvSQLite + FoundationDB | SQLite over a transactional distributed store | Requires FDB operations and maintainer/maturity diligence; not turnkey |
| SQLite Cloud Backed SQLite | Object-storage-backed SQLite component | Integration/writer/storage semantics remain our work |
| SlateDB | Interesting object-store storage substrate | Key/value, not a replacement for arbitrary SQL without building a layer |
| Rivet storage extraction | Architecturally close | Coupling/maintenance/license/extraction work needs direct project cooperation |

Layerbase and other small hosted libSQL providers are research leads, not verified scale substitutes. Before endorsing one, obtain maintained docs/source, SLA/support, data export, credentials, real DB-count limits and load evidence. Do not use a numeric 'fit score' to conceal missing operational evidence.

## Default choice principle

Choose the smallest existing component that removes an actual engineering responsibility. Turso can remove managed database storage engineering; it cannot remove our fencing, command receipts, cross-store bridge or projection correctness. A self-hosted VFS may remove some storage code but create a larger operations project.

## Escape path

Keep explicit provider catalog IDs and export/import tools; use tested SQL features; rehearse moving a sample actor fleet with receipts/incarnations and projection rebuild. 'Database is a service' is not enough portability. Dialect and transactional semantics remain part of the application contract.

## Sources and evidence

- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
- [T05: libSQL repository](https://github.com/tursodatabase/libsql) — Self-hosted engine/server source; not a promise of Cloud feature or economics parity.
- [C06: Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/) — Separate DB hosting candidate with provider-specific API and limits.
- [C12: mvSQLite](https://github.com/losfair/mvsqlite) — FoundationDB VFS research alternative; operational and maintenance diligence required.
- [C13: Cloud Backed SQLite](https://sqlite.org/cloudsqlite/doc/trunk/www/index.wiki) — Storage component rather than hosted actor platform; supported object stores and write semantics matter.
- [C14: SlateDB](https://slatedb.io/docs/) — Object-store KV design; not an arbitrary SQL database replacement.
- [C15: Neon branching](https://neon.com/docs/introduction/branching) — Coarser tenant/workspace relational isolation option, not a drop-in SQLite actor DB.
- [C01: Rivet actor documentation](https://rivet.dev/docs/actors) — Closest general actor platform; current feature claims must come from docs, not blanket superiority claims.
