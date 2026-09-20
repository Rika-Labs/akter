# Research method and limitations

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Evidence hierarchy

Use pinned primary source for implementation behavior; official documentation for supported APIs/product contracts; official pricing pages for timestamped published rates; issue trackers for reproducible risks, not proof a bug remains unfixed; and community discussions only to identify questions requiring primary verification.

The prior source pass inspected Effect snapshot `9ad9891e24058065bcd445772e005f8ce4b3e42f` and OpenCode snapshot `5a8335857b0ebec44ef6aa1d52b339cf25c329ca`. The current pass carries that work forward and performs additional public web/Parallel Search/GitHub lookups plus automated registry/page retrieval. The source registry records links and notes. Automated HTTP retrieval proves reachability/content metadata, not that every product behavior has been tested.

## Facts versus decisions

A source can establish that a module exists or a transaction is scoped to a client. It cannot establish that our proposed actor framework already supplies a correct combined system. All Durable Actors APIs here are proposals; only the setup/type boundaries are code. Provider prices are not negotiated quotes. Capacity numbers require benchmarks. Licensing recommendations require owner/legal approval.

## Coverage

The dossier covers product model, runtime/database/projection correctness, Bun/Node compatibility, engineering toolchain, CI/release/deployment, security, observability, local/self-host/cloud operations and business economics. It also records deferred paths rather than treating every interesting component as a required dependency.

## Limits

No private customer repository or production account was modified. No actual provider contract, region topology or throughput claim was verified through deployment. The skeleton validation report separates available static tooling checks from unimplemented runtime gates. Missing source/package availability is recorded rather than silently converted into a supported configuration.

## Updating the dossier

Refresh the source/registry probes before implementation; pin actual compatible versions; rerun compiler diagnostic sentinel checks; and turn each conditional ADR into accepted/rejected with linked evidence. Keep historical observations so later engineers can see why a decision changed.

## Sources and evidence

- [E01: Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json) — Inspected source snapshot identifies 4.0.0-rc.115. A repository version is not proof that every registry artifact is available.
- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
