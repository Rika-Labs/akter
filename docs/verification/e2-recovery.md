# E2 recovery evidence

**Responsibility:** bind the bucket-log engine's ownership, recovery, drain, freshness and build-matching guarantees to executable evidence.
**Authority:** verification evidence for the E2b promotion; this page does not promote the E3 cluster or host-runtime clauses.
**Owner role:** runtime and reliability.
**Change policy:** each durable transition names the wrong implementation it rejects. Filesystem, simulator and MinIO results are separate claims; none is evidence for an untested production provider.

## Boundary and commands

The engine uses one `Store.Store` for the shard log, epochs, checkpoints, pages and lease freshness. The runner layer decides assignment; `Engine.assign` is the test seam for that decision. When Store fences an owner with `StaleEpoch`, the engine closes the shard as `fenced` and answers callers with `ShardMoved`. Only a later assignment reopens it. An owner that crashes or loses an unavailable append may restart its assigned shard with backoff; that path is intentionally different from a fenced shard.

The repository-only conformance suite is in `tooling/conformance/src/conformance/engine.ts` and `store.ts`. The same engine suite is registered by `packages/akter/src/store/file-system.test.ts` and `s3.test.ts`. Run focused evidence from the repository root with:

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/execution/ownership.test.ts packages/akter/src/testing/simulation.test.ts
node node_modules/vitest/vitest.mjs run packages/akter/src/execution/ownership.test.ts packages/akter/src/testing/simulation.test.ts
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/store/file-system.test.ts
node node_modules/vitest/vitest.mjs run packages/akter/src/store/file-system.test.ts
TEST_S3_URL="$TEST_S3_URL" bun run --cwd packages/akter test:integration
```

E2b validation on the Mac recorded the following results. These are separate from the dated E1 measurements in [E1 execution](e1-execution.md):

| Run                                                                   | Recorded result                                                                                                                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem engine conformance, Bun and Node                           | All six engine scenarios passed on each runtime                                                                                                                                        |
| MinIO `packages/akter` `test:integration`, Bun and Node               | 25/25 on each: 17 Store, six Engine, two transport edge cases                                                                                                                          |
| Full `packages/akter` test, Bun                                       | 143/143                                                                                                                                                                                |
| `testing/simulation.test.ts` plus `execution/ownership.test.ts`, Node | 25/25, including the 1,000 crash-seed and 200 moving-seed matrices                                                                                                                     |
| Replay-filter stress, Bun and Node                                    | Ten repetitions per runtime of both replay tests (50 stationary seeds and 20 moving seeds), while 14 separately tracked `yes` workers ran: zero failures and zero `TestClock` warnings |
| Separate moving-seed scanner                                          | 1,000 moving seeds clean                                                                                                                                                               |

The integration result names MinIO, not R2, Tigris or AWS S3. The replay stress is determinism evidence under host contention, not a CPU-qualified performance benchmark.

For MinIO, start `docker compose -f packages/akter/compose.yaml up --wait` and configure `TEST_S3_URL` from that compose file before `test:integration`; remove the containers afterwards. Repeat the stress run with `-t 'replays a.*seed exactly'` on the simulator test file. The normal suite runs both the matrices and the 50/20 replay checks.

## F6–F12 mapping

| Failure | Scenario and evidence                                                                                                                     | Wrong implementation rejected                                                                                                   | Status                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| F6      | `ownership.test.ts` “a crash after the append is durable and before the reply”; engine conformance restart and SIGKILL cases              | A durable action is lost, a retry runs the handler twice, recovery republishes an event, or a timer disappears after owner loss | Focused simulator; engine suite on filesystem and MinIO, Bun/Node                                                                 |
| F6′     | Store conformance lost-response append; engine conformance ambiguous append; `s3.test.ts` adapter read-back case                          | Retry writes at a new offset, treats an overtaken `412` as success, or resends an unknown write                                 | Store/engine suites on filesystem and MinIO, Bun/Node                                                                             |
| F7      | `ownership.test.ts` stale epoch after move; Store conformance stale append and overtaken lost response                                    | A stale owner publishes a late append, answers from fenced memory, or reopens because a caller touched the shard                | Focused simulator; Store suite on filesystem and MinIO, Bun/Node; not Cluster evidence                                            |
| F8      | `ownership.test.ts` two runners and Store conformance concurrent opens                                                                    | Two owners share an epoch or both append after a create-once race                                                               | Focused simulator; Store suite on filesystem and MinIO, Bun/Node; production-provider atomicity remains T5                        |
| F9      | Ownership checkpoint page/manifest crash cases; Store and engine conformance page/manifest interruption and checkpoint fallback           | Recovery trusts orphan pages or a newer incomplete manifest, losing the previous checkpoint or tail                             | Focused simulator; Store/engine suites on filesystem and MinIO, Bun/Node                                                          |
| F10     | `ownership.test.ts` unavailable/slow bucket; Store conformance retry and freshness cases                                                  | A storage error leaks to callers, publication precedes durability, or a slow owner answers from an expired lease                | Focused simulator; Store suite on filesystem and MinIO, Bun/Node; provider latency remains T5                                     |
| F11     | `ownership.test.ts` graceful and timed-out drain; engine conformance drain under load                                                     | Drain drops admitted work, publishes after handoff, omits `Released`, or reports the wrong offset/`nextDue`                     | Focused simulator; engine suite on filesystem and MinIO, Bun/Node; readiness and `DRAINED` output remain E3/host work             |
| F12     | `ownership.test.ts` and engine conformance old-build tail: new build refuses, matching old build replays and drains, then new build opens | Current code silently replays another build's actionable tail or treats a clean `Released` handoff as an actionable tail        | Focused simulator; engine suite on filesystem and MinIO, Bun/Node; image retention/replay-runner orchestration remains Cloud work |
| F12′    | Build identity includes runtime and engine fields; recovery policy supports `replay: "current"` only by opt-in and still compares effects | Node/Bun or engine-version changes are accepted as matching by bundle name alone                                                | Policy and same-runtime evidence exist; a cross-runtime recovery run is not claimed here                                          |

## Recovery, handoff and timers

The real-store scenarios cover six additional crash boundaries: restart with a pending timer; drain and handoff under load; refusal of a build-mismatched tail followed by old-build drain and new-build open; ambiguous append; interruption between page and manifest; and a SIGKILLed owner whose acknowledged calls are retried by the next owner. They assert durable state, action counts, timer delivery, checkpoint offset, `Released` tail, and no duplicate command id rather than only successful calls.

Drain returns `{ outcome, shards: [{ shard, offset, nextDue }] }`. A clean shard has a checkpoint at `offset - 1` and one final `Released` entry at `offset`; `nextDue` is the earliest pending timer in epoch milliseconds or `null`. A timed-out shard closes without publishing undurable work. Build matching checks actionable `Action`/`Seed` entries; empty `Open` and bookkeeping-only `Released`/`Skipped` entries do not force application-code replay.

Cron recovery has one pending tick per entry. The default `cronSkipIfOlderThan` is one hour, inclusive at exactly one hour: the pending tick fires at or below the boundary, while a later tick writes durable `Skipped` bookkeeping and schedules the first future occurrence. The focused tests use exactly 60 minutes, 60 minutes plus one millisecond, and three days plus five minutes of lateness and assert both tick counts and persisted skip counts. The exact-boundary pair passes on Bun and Node. Downtime of several days still produces one skip, never a backlog.

## Seeded matrices and determinism

`testing/simulation.test.ts` runs 1,000 faulted seeds on one runner and 200 moving seeds over two runners. The moving matrix assigns, drains, pauses and partitions owners; it does not claim real Cluster routing, membership, mTLS or readiness. Two-run byte-for-byte replay covers 50 seeds and 20 moving seeds. The simulator uses Store's native synchronous SHA-256 (`node:crypto` `createHash`) and disables the host-timed `TestClock` warning fiber, so neither a global crypto monkeypatch nor host warning timing enters seeded ordering.

The engine's `Store.fresh` is the sole validity source. It becomes false after the Store's `validFor` interval (default 10 seconds), and the engine verifies before serving reads or duplicate outcomes after expiry. A stale epoch remains fenced until assignment; an unavailable or crashed assigned owner can restart. This distinction is checked by F7 and the freshness scenarios.

## What this does not establish

- Production-provider atomicity and performance are not established. R2/Tigris latency and conditional-create races belong to T5; this page must not turn filesystem or MinIO evidence into a result for another provider.
- E3 owns real multi-runner routing, readiness/unready transitions, DST behavior, no-open-before-release (F24), host wake from `nextDue`, mTLS and self-host `DRAINED` output. `Engine.assign` is not evidence for those clauses.
- E5 owns durable jobs, step retries and `onFailure`; E6 owns page trees, retention and garbage collection. This milestone's checkpoint tests use the current in-memory durable image and Store page/manifest protocol.
- The six measured benchmark repetitions establish no T1 throughput pass and no T2 pass. The Mac is not CPU-qualified for those targets; the measurements are recorded separately in `BENCHMARKS.md`, and provider performance remains T5 work.
