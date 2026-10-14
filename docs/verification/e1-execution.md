# E1 execution evidence

**Responsibility:** bind the 0.2 engine's single-process claims (contract, handlers, synchronous execution, deduplication, group commit, snapshots, recovery and `Simulation`) to executed scenarios.  
**Authority:** verification evidence.  
**Owner role:** runtime and reliability.  
**Change policy:** a new durable transition needs a scenario that names the wrong implementation it rejects, and the seed matrix must stay green on Bun and Node.

The engine lives in `packages/akter/src/` under `contract/`, `handlers/`, `execution/`, `snapshots/` and `testing/`. It runs on the [Store](store-protocol.md) from `src/store/`: every append, read, checkpoint and lease check goes through `Store.Store`, and nothing else is durable. The root entry exports the contract and the client (`Actor`, callers, errors); `./server` exports the store; `./testing` exports `Simulation`. The normative targets are the [actions](../contracts/02-actions.md), [durability](../contracts/03-durability.md), [messaging](../contracts/05-messaging.md), [background work](../contracts/08-background-work.md) and [recovery](../contracts/09-recovery.md) contracts and [ADR 0128](../decisions/0128-constrained-actor-api.md). Everything here runs in one process against the store's memory bucket, so none of it is a provider or real-bucket result. [E2 recovery](e2-recovery.md) extends this evidence with multiple engine instances, ownership moves, drain, cron catch-up and real-store recovery.

## Commands

From the repository root, on Bun and then on Node:

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/{contract,handlers,execution,snapshots,testing}
node node_modules/vitest/vitest.mjs run packages/akter/src/{contract,handlers,execution,snapshots,testing}
```

`packages/akter` `test` runs the same files with the store's suites. The original E1 run on 2026-10-12, with Bun 1.4.2 and Node 26.7.0 on macOS arm64, passed 41 of 41 tests in six files on both runtimes. Its 1,000-seed matrix took 22 s on Bun and 33 s on Node; its seed replay test took 2 s and 4 s. These are the dated E1 results, not timings or counts for E2b's expanded suite. `bun run pack:smoke` (and `SMOKE_RUNTIME=node`) installs the packed tarball into a clean project and runs an actor through `Simulation` from `@rikalabs/akter/testing`; [`pack.test.ts`](../../.github/src/pack.test.ts) builds a consumer of the root entry for Bun and Node and finds no AWS/Smithy module and no module from `execution/`, `snapshots/`, `store/` or `testing/`.

## The simulator

`Simulation.run(options, program, implementations)` builds one or more runner engines over `Store.Store` on a shared memory bucket and runs the program on a seeded fiber scheduler with `TestClock`. A run is a function of its seed:

- The scheduler picks among runnable fibers with a seeded generator. Store page hashing is synchronous SHA-256; there is no global `crypto.subtle.digest` monkeypatch or hashing host promise that can reorder fibers.
- The clock driver wakes only when no fiber can run. It moves `TestClock` in growing steps while work sleeps (store retries, delivery and restart backoff, jobs, client retries) and straight to the next one-shot timer when nothing else is left, rounding up so a fractional jittered time cannot stall it.
- `Math.random` is replaced by a seeded generator for the run, and every action runs twice on cloned state (I9).
- `TestClock` uses `warningDelay: Duration.infinity`. Its host-clock warning fiber is disabled because a host-timed warning would enter the seeded queue at a host-dependent point.
- Faults sit between the store and the bucket, off until the engine is built: a crash before or after a log segment is written (the owner's shard crashes and the call fails, as a dying owner would see it), a lost response after a write lands, an outage that fails the striking call and up to seven more (some outlast the store's six attempts), and slow calls that yield fewer than 20 scheduler turns.

`Simulation.settle` waits until nothing is staged, in flight, opening, restarting, delivering, due or running and no client call waits, then checks the invariants against the bucket itself and fails with `InvariantViolation`, whose message names the seed:

| Check    | What it reads                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| I1       | Every segment with entries carries the open offset of the newest open segment before it.                                                     |
| I2       | Every published entry is in the log at the offset it was published from, with the same effects.                                              |
| I3, I6   | Replaying each shard from nothing and from every checkpoint reaches the live durable image's fingerprint, with every replayed outcome equal. |
| I4       | No command id is durable twice.                                                                                                              |
| I5       | No stream sequence is applied twice, and every send its sender marked delivered was applied.                                                 |
| I9       | Both runs of every action produce the same outcome and staged effects.                                                                       |
| Liveness | A run still busy after 100,000 stalled driver turns fails with what is left, such as `shard 1 has 1 undelivered sends on 1>2`.               |

Run `n` of a matrix uses seed `SIMULATION_SEED_BASE + n` (`0x5eed0000 + n`), and a failing run names both.

## Scenarios

| Scenario                                                                                                                                                                          | Test file                     | Wrong implementation it rejects                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A state field without a decoding default, a reused or reserved member, a bad `onFailure`, a cron action with a payload or a fixed-offset zone is refused                          | `contract/make.test.ts`       | Accepting contracts the runtime cannot honor, or checking only at runtime what the types promise                         |
| Handlers are typed as synchronous functions of the draft, payload and context; callers narrow by `access`; step results are JSON or name a schema                                 | `contract/make.test.ts`       | Handler types that admit `Effect` or `Promise` results, or a caller type wider than `access` allows                      |
| The copy-on-write draft matches plain JavaScript on a deep copy over 40,000 random recipes, never writes the base and reports exactly the changed fields                          | `handlers/draft.test.ts`      | A draft that leaks writes into the base, loses aliasing, or reports untouched fields as changed                          |
| A declared failure or thrown error discards the draft and every staged effect; an action that awaits or sleeps, or a context used after return, is a defect                       | `execution/action.test.ts`    | Keeping staged sends or events of a failed action (F1), or accepting asynchronous actions (F2)                           |
| State over 256 KiB encoded is a `StateTooLarge` defect at one byte past the cap; ids, time and randomness derive from the command id and admission time                           | `execution/action.test.ts`    | An off-by-one cap, or ids and randomness that differ on replay                                                           |
| A discarded action publishes no event, delivers no send and fires no timer, and its outcome is recorded                                                                           | `execution/engine.test.ts` F1 | Publishing or delivering before the outcome is known                                                                     |
| Nothing is visible before the segment is durable; after a crash the client's retry with the same id applies once                                                                  | `execution/engine.test.ts` F5 | Publishing speculative state, or running a retried id twice                                                              |
| A same-shard send whose sender entry is lost never delivers; the retried id runs both once                                                                                        | `execution/engine.test.ts` F3 | Delivering a send whose sender was never durable                                                                         |
| A client id runs once in its window and is refused when misused or expired; a redelivered send applies once by its watermark; a replayed job call answers from the stored outcome | `execution/engine.test.ts` F4 | Deduplicating only in memory, accepting sequence gaps, or rerunning a job call                                           |
| Internal members, undecodable payloads and anonymous callers are refused before running                                                                                           | `execution/engine.test.ts`    | Admitting calls the contract forbids                                                                                     |
| Reads are answered from memory within `validFor`; once it has passed, a lease another owner fenced refuses them                                                                   | `execution/engine.test.ts`    | Treating process memory as authority after the lease may have moved; the test fails when the check is removed            |
| Every shard reopens after a crash and rebuilds from its newest checkpoint and tail to the same states, outcomes and timers                                                        | `snapshots/recovery.test.ts`  | Recovery from the oldest checkpoint, a checkpoint that misses timers or outcomes, or keeping the old image               |
| Changed handler code under the same build stops replay with `ReplayMismatch`; another build's tail is refused unless the policy is `current`; a corrupt entry is `CorruptLog`     | `snapshots/recovery.test.ts`  | Replaying without comparing outcomes, ignoring the segment's build, or defaulting undecodable entries                    |
| Four examples (transfer with refunds, an outbox of jobs, a streaming agent, a chat room with a client session) run end to end and settle clean                                    | `testing/simulation.test.ts`  | Regressions across sends, timers, jobs, retries, `onFailure`, presence, state frames and patches, views, events and cron |
| A closure counter and `Math.random` in a handler fail I9 naming the seed; the context's `random` passes                                                                           | `testing/simulation.test.ts`  | A simulator that cannot see nondeterministic handlers                                                                    |
| 1,000 seeds of twelve concurrent transfers among five accounts, with an operator crash of every shard mid-run, under all four faults                                              | `testing/simulation.test.ts`  | Lost, duplicated or replayed effects: money must total 500, received must equal sent, one audit timer per transfer       |
| Two runs of each of 50 seeds write the same log and checkpoints byte for byte                                                                                                     | `testing/simulation.test.ts`  | A simulator whose interleavings depend on host timing, so a failing seed does not reproduce                              |
| 200 seeds over two runners move, drain, pause and partition the owner under the same faulted transfers; two runs of each of 20 moving seeds agree                                 | `testing/simulation.test.ts`  | Lost sends or timers during ownership changes, autonomous reopening of fenced shards, or host-dependent replay ordering  |

`AKTER_SIMULATION_SEEDS` and `AKTER_SIMULATION_MOVING_SEEDS` raise the two matrices' seed counts for a long run; both [passed at 10,000 seeds](history/2026-10-14-t7-10000-seeds.md) on Bun and Node. The matrix also asserts that, across its runs, transfers were refused for insufficient funds and crashes, lost responses and outages each struck, so a fault plan that silently stops firing fails it.

## What the matrix found

Each of these failed the matrix, or the seed replay test, before its fix; the fixes are in `execution/engine.ts` and `testing/`:

- A delivery fiber of a crashed generation marked a send acknowledged in the new generation, so the new owner skipped it and it was never delivered (`liveness: shard 1 has 1 undelivered sends on 1>2`). Delivery now stops touching shard state once its generation is stale.
- A crashed shard stayed closed until a caller touched it, so its timers never fired (six of eight audits). The engine now reopens a shard after its own append failure or crash, with backoff, unless another owner fenced it.
- An open abandoned by a crash landed after the restart's open and fenced the owner's own new lease, which closed the shard for good with money in flight. Opens of one shard now run one after another, and an open runs in the engine's scope, so a caller that gives up never leaves a shard half open.
- A jittered store retry made the test clock fractional, and the driver advanced by less than a millisecond forever. It now rounds up.
- Host digests resolved at host-dependent times, so 11 of 30 E1 seeds wrote different logs on a second run. E1 held the scheduler while a digest was pending; E2b removes that global crypto patch by making Store hashing synchronous. The clock driver still wakes only on idleness, and the host-clock `TestClock` warning is disabled.

## Left to later milestones

- `PageMiss` and its rerun (F1's third case) need the page tree of E6; the engine keeps whole shard images in memory.
- E2b now exercises two owners, stale epochs, partitions, engine drain/`Released`, Store-owned freshness and persisted cron skips. The simulator's assignment operations model the runner layer; they are not real Cluster routing, membership, mTLS or rollout evidence (E3).
- Retention-aware trim and garbage collection (I7), tenancy (I8), and `disconnect` for connections a previous owner recorded remain unestablished here.
- Real-store recovery is recorded separately in [E2 recovery](e2-recovery.md). Provider performance, production-bucket atomicity, real suspension/clock discontinuities and host wake-from-zero are not established by a memory-bucket run.
