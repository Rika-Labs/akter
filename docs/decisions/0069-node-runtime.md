# ADR 0069: Node and Bun runtime portability

**Status:** accepted (2026-10-03), implementing #490's requested Node support.

## Context

#490 requires the framework and served applications to run on Node as well as Bun. Bun-only synchronous codecs and an eager FFI import previously made even a Postgres runtime fail to import under Node. The served API already accepts an Effect HTTP server, so a second actor execution engine would duplicate authority and recovery logic unnecessarily.

## Decision

`@rikalabs/akter`, its runtime, served protocol, Promise client and testing entry support Bun 1.4.2+ and Node 24+. Effect remains the runtime foundation. Applications provide `BunCrypto` and `BunHttpServer` on Bun or `NodeCrypto` and `NodeHttpServer` from `@effect/platform-node` on Node; `Actors.serve` continues to register platform-independent Effect HTTP routes.

The synchronous storage boundary selects Bun's native xxHash3 and zstd on Bun, and native xxHash3 plus `node:zlib` zstd on Node. Routing encoding 1, signed routing keys, content SHA-256 and zstd state frames do not change. Reading data written by the other runtime must not require a migration. Browser-facing actor definitions retain a browser-safe SHA-256 fallback, while Bun uses its native hasher.

Node HTTP requests carry relative URLs, so origin validation derives their scheme from the transport socket rather than assuming the original URL is absolute. Forwarded-protocol headers and absolute request targets do not override that socket scheme.

WebSocket shutdown protects connection cleanup from interruption once it publishes the ended session. Otherwise the outbound reader can finish and interrupt the inbound closer before the owner deletes the durable row. A real-Postgres case blocks the deletion with a row lock and proves cleanup survives that race; removing the interruption protection makes it fail.

The Promise client keeps browser error reporting where available and falls back to Effect's error logger on Node. A throwing optimistic or offline-queue listener cannot prevent the other listeners from being notified. TypeScript sources use erasable constructor syntax so native Node TypeScript stripping can run conformance subprocesses without experimental transform flags.

File-backed PGlite keeps the exclusive kernel `flock` required by [ADR 0035](0035-pglite-embedded-production-backend.md). Bun dynamically loads its FFI implementation only when locking a directory; Node uses Koffi to reach the same libc calls. No PID-file or stale-lock cleanup protocol is introduced. Linux and macOS local filesystems remain the only supported embedded-production platforms, and power-loss durability remains unverified.

## Evidence and limits

`bun run test:node` runs the core Postgres conformance shards in Node workers against real Postgres, not a mocked driver or PGlite replacement. It also exercises persisted routing vectors, cross-runtime zstd frames, SHA-256 vectors, and the packed quickstart's file-backed restart. `check:ci` invokes it from the root script because the evidence gate refuses PR-modified verification workflows. The existing Bun suite and tarball smoke run in the same Verify invocation.

The CI runner executes Node core checks and Turbo concurrently to preserve Verify's existing timeout. Each gets its own primary and streaming replica because fleet's logical-slot name is cluster-global and WAL pause is server-wide. Tarball quickstarts run first so packing cannot delete build output during Turbo's build. New replica control connections wait for database creation to reach the standby before they are exposed; subsequent reads still prove their actual replay position. An existing Docker container is refused rather than deleted, and a failed verification child causes its sibling to be terminated.

Node process-kill drills, provider topologies, Windows file-backed PGlite, network filesystems and power loss are separate gates; this decision does not claim them from core conformance success. Node and Bun share contracts for transactions, receipts, outbox, timers, fences and served errors; selecting a platform layer cannot weaken those guarantees.

## Alternatives and consequences

Changing Node placement hashing to SHA-256 would break stored routing keys, so it is rejected. A JavaScript PID-file lock would leave stale files after a crash and introduce an ownership race, so it is rejected. Native xxHash3 and FFI dependencies increase package size but preserve the durable contracts. Bun keeps native hashing, compression and FFI fast paths; Node uses equivalent primitives rather than a parallel runtime.

## Revisit when

PGlite supplies its own kernel-backed directory lock, Node gains a built-in xxHash3 implementation, or Node subprocess and hosted-provider evidence expands the support matrix.
