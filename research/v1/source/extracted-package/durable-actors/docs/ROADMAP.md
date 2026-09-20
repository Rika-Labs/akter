# Execution roadmap

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Milestone 0 — evidence and tooling

Confirm dependency registry versions, Effect diagnostics enforcement, Node/Bun build/import behavior and provider capability matrix. Produce a minimal source spike for the actual Effect Cluster handler shape. No public stable API yet.

## Milestone 1 — single-actor truth

Implement local transaction, receipt/result storage, stable command IDs, schema decoding and fence validation. Prove crash-after-commit replay without another store. Add meaningful mirrored unit/contract tests.

## Milestone 2 — distributed delivery bridge

Integrate persistent Cluster messages and Postgres control storage. Transfer outbox intentions with stable IDs. Prove source receipt recovery after PostgreSQL reply loss and durable discovery after sleep. Test two candidate owners and direct-session lock loss.

## Milestone 3 — real private DB provider

Implement idempotent provisioning, per-actor credentials, migration/compatibility, remote rollback/fence tests, deletion and incarnation-safe restore. Benchmark actual per-actor metadata and write costs.

## Milestone 4 — usable application

Build one domain control-plane example with HTTP/CLI, durable submission status and SSE replay. Add one-shot timers, inspect commands and bounded admission. Test Bun and Node adapters end-to-end.

## Milestone 5 — recoverable external work

Adopt the Effect Workflow bridge only if its named input/result/replay semantics fit. Demonstrate an idempotent external operation plus unknown-outcome recovery and cancellation.

## Milestone 6 — projection beta

Implement single-source table capture and one customer-owned PostgreSQL sink. Prove bootstrap, deletes/key moves, duplicates, resnapshot and outage/backlog limits. Only then consider a single-source ProjectionActor.

## Milestone 7 — managed design partners

Dedicated application deployments, provider contracts, usage meter, restore drills, security review and support runbooks. Publish measured limits, not broad scale promises.

Each milestone exits through evidence in VALIDATION_GATES. Schedule and staffing are planning variables; do not pretend these milestones have fixed completion dates before the founding team and scope are known.

## Sources and evidence

- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
- [D02: Railway private networking](https://docs.railway.com/guides/private-networking) — Must validate per-replica identity/routing, not use one load-balanced address as runner identity.
