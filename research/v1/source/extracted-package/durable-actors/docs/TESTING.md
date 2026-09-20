# Test strategy

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Choice

Use Vitest with the exact @effect/vitest-compatible major for semantic/unit tests. The inspected Effect rc.115 package expects Vitest 5, so blindly installing a familiar older major is wrong. Use Bun's native test runner for Bun-specific import/platform cases; share pure conformance scenarios rather than claiming a Node-run Vitest invocation tests Bun execution.

## Layers

1. Static: formatter, Oxlint, all Effect diagnostic rules as errors, typechecking, dependency/export validation.
2. Unit: pure protocol codecs, descriptor metadata, routing IDs, retry policies, state transitions using test Layers/clock.
3. Adapter: real libSQL/SQLite and PostgreSQL transaction behavior, resource cleanup, serialization and schema mapping.
4. Runtime conformance: same contract suite against single-process, clustered Bun and clustered Node hosts.
5. End-to-end: gateway authentication, durable submissions, SSE reconnect, CLI, projection destination.
6. Fault/soak: process kills, stale owners, network failures, long retained histories, upgrades and reconciliation.

## Mirroring

`src/actor/address.ts` maps to `test/actor/address.test.ts`. Fixtures live in test/support. API type tests live under test/types or mirrored `.test-d.ts` conventions with a dedicated compiler config. Integration tests must not leak provider secrets into snapshots or logs.

## Test time

Use Effect TestClock for logical timers/backoff. Real lease/storage/proxy behavior still needs wall-clock integration testing. Do not make a virtual clock test the sole evidence for clock-skew correctness between machines.

## Failure oracles

Assert invariants from durable records independent of handler return values: number of applied commands, monotonically installed fence, retained encoded result, outbox stable IDs, source/sink checkpoint agreement and no resurrected tombstones. A test that simply retries until eventual success misses duplicate mutation.

## Generative tests

Generate sequences of create/update/delete, duplicate delivery, key move, connection loss and restart. Compare projections to a reference model. Test all supported Schema storage codecs and migration paths. Preserve seeds and minimized failure traces.

## What exists now

Scaffold tests verify source/export shapes and metadata only. Durability tests are specified as gated scenarios, not implemented with fake services. Passing them is explicitly not claimed in VALIDATION.md.

## Sources and evidence

- [E08: Effect Vitest package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/vitest/package.json) — Inspected rc.115 package requires Vitest >=5 <6.
- [D12: Vitest documentation](https://vitest.dev/guide/) — @effect/vitest peer compatibility controls major version.
- [B05: Bun testing](https://bun.com/docs/test) — Native runtime test runner; not a substitute for @effect/vitest APIs.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
