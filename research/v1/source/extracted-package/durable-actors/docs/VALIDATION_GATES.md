# Go / no-go gates

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Gate | Must establish | Evidence required | Blocks |
|---|---|---|---|
| G01 Toolchain | Exact package tuple exists and strict Effect diagnostics run | Registry/lock + sentinel + type/lint/build logs | Implementation baseline |
| G02 DB capability | Remote endpoint supports required tx/triggers/primary reads | Actual provider integration suite | Turso adapter choice |
| G03 Fence | Stale owner cannot commit after successor DB fence | Two-process failpoint trace + DB oracle | Any durability claim |
| G04 Receipt bridge | Local commit survives missing PG reply without repeat | Kill/lost-ACK replay test | Cluster runtime alpha |
| G05 Discovery | Sleeping actor outboxes cannot become undiscoverable | Crash between local commit/relay/ACK at every point | Timers/work/projections |
| G06 Topology | Unique runner routing + session lock connection behavior | Railway/private-network/direct PG test | Hosted scale-out |
| G07 Projection | Ordered/idempotent bootstrap/replay/delete/key-move | Source/sink oracle including retention gap | projected() beta |
| G08 Isolation | Auth/credentials/resource boundaries protect tenants | Security tests and independent review | Shared cloud |
| G09 Packaging | Node/Bun consumer can use packed artifacts | publint/types/import/type fixtures | npm release |
| G10 Work bridge | Named workflow replay/completion semantics safe | Provider idempotency/unknown-result scenarios | Activities API |
| G11 Operations | Backup/restore/upgrade/runbooks exercised | Staging game-day record | Paid reliability promises |
| G12 Economics | Costs measured with write/index/retry amplification | Meter reconciliation + provider quote | Public usage pricing |

## Status vocabulary

Proposed: designed but not tested. Static-checked: source/config/shape verified. Integration-verified: exercised against real components. Operationally-verified: repeated in deployed staging under load/faults. Commercially-approved: provider contract and pricing/support obligations signed. Do not collapse these into one 'done' checkbox.

This repository's generated VALIDATION.md reports only work actually performed during artifact generation. It cannot mark runtime gates verified because no runtime implementation is included.

## Sources and evidence

- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
- [D02: Railway private networking](https://docs.railway.com/guides/private-networking) — Must validate per-replica identity/routing, not use one load-balanced address as runner identity.
- [D07: npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) — Validate supported hosted CI environments; keep release job independent from Blacksmith.
