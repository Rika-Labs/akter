# 16 — Local development and evidence gates

**Status:** local testability and one runtime direction are requirements. Every experiment below is planned, not an executed runtime test.

[Index](../../README.md) · [Sources](../../SOURCES.md) · [v2 validation](../../../v2/VALIDATION.md) · [Deployment](../14-deployment/README.md)

## Test the real boundary

```diagram
type fixtures → handler tests → real Postgres integration
                                      │
                                      ▼
                         multi-runner fault tests
                                      │
                                      ▼
                       actual multi-shard Neki tests
                                      │
                                      ▼
                   provider / gateway / query conformance
```

The same command, ownership, receipt and delivery mechanisms should run locally and in production. Test clocks, external-service fakes, filesystem/memory blobs, and optional PGlite provide convenience—not alternate correctness semantics. PGlite cannot validate multi-process Postgres locking, and a mock Neki adapter cannot validate Neki routing.

## Proposed test experience

```ts
// Illustrative specification, not executable against this repository.
it.effect("never publishes a rolled-back message", () =>
  Effect.gen(function* () {
    const test = yield* ActorsTest
    const room = test.client.chat({ tenantId: "acme", id: "general" })
    const observed = yield* test.capture(room.subscriptions.messages())

    yield* test.faults.failOnce("turn.beforeCommit")
    const pending = yield* test.submit(room, "sendMessage", {
      id: "m-17", body: "Hello",
    }, { commandId: "send-17" })

    yield* test.runOneAttempt(pending)
    yield* test.expectNoCommittedRowsOrEvents("m-17")
    yield* test.settle()
    yield* test.expectCommittedMessages(["m-17"])
    yield* test.expectEvents(observed, ["messageAdded:m-17"])
  }),
)
```

Expected state is derived from accepted logical operations, not copied from handler outputs. Use asymmetric actors, tenants and payloads. Include failures before and after irreversible boundaries, not just happy-path snapshots.

## Capability gates

| Gate | Wrong implementation to expose | Required observation |
| --- | --- | --- |
| Context/type boundary | One global service permits all methods | Phase-invalid capabilities fail type fixtures and runtime bypass attempts |
| Drizzle transaction | Business query uses a second pool | State, receipts, events and intents roll back/commit together |
| Post-commit publication | Nested savepoint triggers reply early | No client/event success before outer commit |
| Actor fence | Lease alone authorizes writes | Paused old generation cannot commit after handoff |
| Automatic ownership | SQL filters forgotten, RLS silently claimed as error | Exact documented outcomes for own, foreign, missing, broad and mixed-owner writes |
| Neki locality | Hidden receipt/outbox query fans out | Turn rows route to one domain; accidental cross-shard write fails safely |
| Messaging | Lost ack causes duplicate business mutation | Duplicate delivery resolves to one committed transition within retention |
| Timers/cron | In-memory clock or exactly-once tick assumption | Restart/duplicate tick produces documented idempotent behavior |
| Blobs | URL success treated as committed business state | Verified references and recoverable orphan/missing-byte states |
| Workflows | Fiber memory mistaken for durable progress | Replay/versioned steps recover; side effects do not rerun without protocol |
| External effects | Timeout treated as failure | Unknown preserved; provider adapter reconciles before unsafe retry |
| Transfer | Source thaws after destination activation | No dual writable owner; post-release recovery rolls forward |
| Realtime | Snapshot and cursor taken independently | No missing committed event at snapshot/live boundary |
| Live SQL | Delta engine mishandles deletes/joins/top-k | Supported incremental output equals independent full query |
| Hibernation | Socket owned by activation | Activation removal preserves gateway connection; gateway loss reconnects |
| Authorization | Old buffered rows survive revocation | Delivery stops/resyncs at the specified authorization boundary |
| Restore/retention | Old state forgets outside effects | Execution remains fenced until reconciliation is safe |

Feature folders provide more specific experiments. For incremental SQL, publish the supported algebra and property-test generated mutation sequences against independently executed full SQL results. Generate duplicate join keys, NULLs, deletes, group changes and tie boundaries deliberately; mostly-invalid random SQL proves little.

For ownership, ordinary TypeScript tests are insufficient: also issue supported raw SQL and JavaScript calls through restricted production roles, then race concurrent writes/transfers. Test full identities, not only two distinct actor IDs.

## Measurements, not inherited promises

Measure command p50/p95/p99, hot-actor ceiling, database round trips, WAL/storage growth, receipt retention cost, pool waits, mailbox age, worker recovery, blob orphan volume, query refresh/maintenance cost, gateway memory and reconnect waves. Record backend/runtime versions, indexes, dataset, skew, hardware and durability settings.

No comparison or price claim should reuse the archived estimates as benchmarks. Sparse-workload specialization and blanket scaling claims remain undecided.

## Documentation verification versus runtime verification

For this v3 task, verify inventory coverage, Markdown/link integrity, consistent API vocabulary and explicit unproven guarantees. Those checks do not prove that snippets compile against an SDK: the SDK described here does not exist yet. Preserve v1/v2 byte content while adding v3.

Before implementation release, execute this matrix on disposable environments. Paid/shared infrastructure and production writes require their own authorization; the research request does not grant it.
