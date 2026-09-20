# Local development

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Two modes, explicitly different

**Fast mode:** Bun, local file-backed actor DB adapter, in-process/test Cluster, filesystem BlobStore and memory cache. It should eventually require no Docker for ordinary developer work. It does not prove production fencing/network durability.

**Integration mode:** real PostgreSQL plus tested libSQL server/remote test endpoint, two or more runners, gateway and optional external projection DB. Docker Compose provides PostgreSQL locally; a remote Turso test account is used for provider-specific acceptance. Self-hosted libSQL is a different operational deployment and must not be called identical to Turso Cloud.

## Current setup-only experience

`bun dev` starts a minimal documentation/setup portal. It does not fabricate an actor emulator. `bun run check:scaffold` validates package/config structure. `bun run typecheck`, `test`, and `build` validate only existing contract files and tooling. Implementation milestones add runtime commands later.

## Credentials

Use `.env.example` as a variable list. No command auto-creates a paid database or deploys infra. Local app names default to an explicitly non-production value. Production credentials are never loaded as a fallback when dev configuration is missing.

## Planned developer loop

Edit protocol/implementation -> type/lint checks -> local actor restart with safe fence handoff -> run one command -> inspect receipt/journal -> run mirrored tests. Hot reload may require activation teardown and migration compatibility checks. Do not retain stale service instances across reloads and call it correct because a browser updated.

## Fixtures

Seed idempotently with stable IDs. Fixtures include deleted actors, pending timers, failed projections, stale activity completions and multiple code/schema versions. A local reset is explicitly destructive and never targets a remote endpoint without an opt-in flag.

## Sources and evidence

- [B04: Bun install](https://bun.com/docs/pm/cli/install) — Lockfile and trusted dependency lifecycle policies.
- [B07: Bun SQLite](https://bun.com/docs/runtime/sqlite) — Local runtime-specific database, not a remote durable fleet backend.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [T05: libSQL repository](https://github.com/tursodatabase/libsql) — Self-hosted engine/server source; not a promise of Cloud feature or economics parity.
