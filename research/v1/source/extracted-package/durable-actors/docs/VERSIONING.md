# Versioning dimensions

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Version these independently:

- npm package/API version.
- wire envelope/protocol version.
- actor type/application code version.
- actor database schema/migration version.
- actor database incarnation after destructive restore/recreate.
- projection source table schema and sink materialization generation.
- workflow definition/completion protocol version.
- event schema and retained replay format.

A single package version does not solve stored-data compatibility. An actor can wake months later with old state and queued messages. Its assigned code must declare compatible ranges and migrations/decoders.

## Changes that need explicit migration

Renaming a command tag, changing an error schema, narrowing an enum, changing date/boolean encoding, modifying a projection key, changing table identity, changing an idempotency-key digest or dropping receipt history all affect compatibility. Treat those as protocol/data migrations even when TypeScript compilation succeeds.

## Deployment policy

Initial standard: backward-compatible rolling updates only. Code is assigned by manifest, not arbitrary module hot replacement. Expand DB schema first; deploy compatible readers/writers; complete pending old work; then contract. If mixed-version safety cannot be proven, drain/suspend affected actors during the controlled cutover.

## Retention

Supported replay/idempotency windows must be at least as long as the relevant message retry and external workflow return window, or the system needs tombstone/rejection semantics. Do not delete an old codec while retained events still use it. A restoration creates a new incarnation and a documented projection rebuild.

## Toolchain versions

Pin prerelease Effect packages and their adapters to a compatible tuple. Group automated updates. A successful package download confirms availability, not behavior; source review and conformance tests decide upgrade approval.

## Sources and evidence

- [E01: Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json) — Inspected source snapshot identifies 4.0.0-rc.115. A repository version is not proof that every registry artifact is available.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [D13: Changesets](https://github.com/changesets/changesets) — Version/changelog workflow, separate from registry authentication.
