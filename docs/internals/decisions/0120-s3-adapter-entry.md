# ADR 0120: Isolate the S3 cold-storage adapter

**Status:** accepted (2026-10-11).

**0.2 status:** superseded (cold-adapter entry); the no-AWS-in-the-root bundling rule carries; owned by [ADR 0127](0127-snapshots-pages-lists-history-gc.md) and [ADR 0136](0136-stores-the-bucket-is-the-store.md). See the [0.2 registry](0124-engine-rewrite-and-command-log.md#registry-of-earlier-decisions).

## Context

The alpha.6 runtime barrel reaches the S3 adapter even when `Actors.layer` has no cold storage. The SDK's retained module initialization makes cold storage's opt-in runtime configuration insufficient as a bundle boundary.

## Decision

Export `S3ColdStorage.make` and `S3ColdStorageOptions` only from `@rikalabs/akter/cold-storage/s3`, with matching source and published JS/declaration targets. Remove `ColdStorage.s3` and the S3 options type from the runtime entry. Keep the storage interface, error identity, memory/filesystem adapters, S3 operations and scoped-client lifetime unchanged. Cold storage shipped only in alpha.6; this import migration is a breaking alpha API change, not an object-format or database migration.

The runtime must not reach the S3 implementation. A dynamic SDK import inside the existing adapter is insufficient: with splitting disabled, Bun still bundles it. The dependency remains installed for S3 users, but applications that do not import the separate adapter do not bundle AWS/Smithy code.

This trades an alpha import migration for a boundary independent of application bundler settings. Reconsider a shared runtime export only if supported bundlers can prove no SDK modules remain for both split and unsplit builds without requiring configuration from consumers.

## Measurement and evidence

Bun 1.4.2 built the same minimal server entry: a root `Actor.make` declaration and `Actors.layer()` with no cold storage. These are unminified JavaScript bytes, excluding external sourcemaps, with splitting disabled and only native `koffi`/`@node-rs/xxhash` packages external. They are not Akter Cloud API/edge measurements.

| Mechanism              | Bun target bytes | Node target bytes | AWS/Smithy present |
| ---------------------- | ---------------: | ----------------: | ------------------ |
| Original static import |        4,118,834 |         4,150,027 | Yes                |
| Lazy SDK import        |        4,272,114 |         4,224,764 | Yes                |
| Separate adapter entry |        3,005,922 |         3,005,917 | No                 |

The isolated entry saves 1,112,912 bytes for the Bun target and 1,144,110 for Node. No esbuild dev dependency is declared, so no additional bundler was installed for this comparison.

[`pack.test.ts`](../../../.github/src/pack.test.ts) rejects a runtime barrel or cold-storage interface module that transitively imports AWS/Smithy code, using actual Bun build metadata rather than text-size thresholds. The unchanged MinIO assertions exercise the adapter through its new public path. [Cold-tier verification](../verification/cold-tier.md) describes the operation and release evidence; hosted durability/latency limits remain unchanged.
