# ADR 0129: Jobs, the timer wheel and `ShardWorkflowEngine`

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** decide how I/O runs (jobs), how timers and cron fire, how both survive owner changes and scale to zero, and what happens to cancellation.

**Owner role:** runtime.

## Context

0.1 has two background mechanisms: jobs staged by `turn.enqueue` and executed by `X.toJobLayer` executors with `onSuccess`, `onDeadLetter` and `onCancelled` routes, and workflows declared with `Actor.workflow` running on a framework `WorkflowEngine` over SQL tables, with `WorkflowRun` handles, owner-event waits and version markers ([ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md), [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md), [ADR 0022](0022-workflow-engine-storage-and-version-markers.md), [ADR 0024](0024-effect-cancellation-and-per-actor-concurrency.md)). Timers and cron ticks are outbox rows claimed by a relay with leases.

D23 rule 7 makes jobs the only place for I/O and folds workflows into them; rule 5 makes `cron` an action option. Actions are synchronous ([ADR 0125](0125-synchronous-deterministic-actions.md)), so every wait lives in a job or on the timer wheel. The documentation audit asked that cancellation's fate be stated explicitly rather than lost.

## Decision

### 1. Jobs

- A job is declared with `Actor.job({ payload, retry?, timeout?, concurrency?, onFailure })` and implemented in the actor's one `toLayer` as `(payload, { self, step, emit, id, attempt }) => Effect`. Its requirements flow into the layer type; action handlers stay requirement-free.
- An action stages a job with `ctx.start.<job>(payload, { key? })`. The job starts only after the action's segment is durable; a failed action starts nothing.
- **Job id.** With a `key`, the job id is derived from the actor address, the declaration and the key, and at most one job with that id is open at a time: a start whose id is already open is recorded and ignored. Without a key, the job id is derived from the starting command id and the start's ordinal.
- **Steps.** `step(name, effect)` runs `effect` once per attempt and journals its encoded result as a `JobStep` entry; a step whose result is journaled never runs again, on replay or after an owner change. Step names are static strings, unique within the job body. A step's result is encoded with a Schema; the exact signature for typed results is settled with the E5 adapter, and `step(name, effect)` alone journals a `void` result.
- **Calls from jobs.** `self.<action>(payload)` and `X.client(id).<action>(payload)` inside a job carry a command id derived from the job id, the enclosing step name (or `body` outside any step), the attempt and the call's ordinal within that scope, and the call and its reply are journaled like a step. A crash replay of the same attempt derives the same ids and is a duplicate; a deliberate retry attempt derives fresh ids. Concurrent calls within one scope must sit in distinct steps, because their ordinals would otherwise depend on scheduling. A replayed job body therefore never resends a finished call. A call whose request may have been delivered but whose reply was not journaled is resent with the same derived id, and the receiver's deduplication answers it ([contract 03](../contracts/03-durability.md)). Job calls travel on a per-job stream whose watermark keeps every unacknowledged outcome until the job completes, so the resent call always gets the original outcome.
- **Caller.** Calls from a job run as `System({ source: "job", ref: <owning actor>, onBehalfOf })`, where `onBehalfOf` is the principal of the action that started the job.
- **Retries and timeouts.** An attempt that fails, defects or exceeds `timeout` is retried as a new attempt with `retry.backoff` until `retry.attempts` is spent. An owner change or crash resumes the same attempt on the next owner. Journaled steps are not rerun; the step that was running reruns. `attempt` is the current attempt number.
- **`onFailure` is required.** When attempts are spent, the engine delivers `Actor.JobFailure { job, declaration, payload, attempts, cause, ambiguous }` to the named action, where `cause` is `Failed`, `Defect` or `Timeout`, and `ambiguous` is true when the last running step may have reached its provider. The `onFailure` action accepts only `System` callers ([ADR 0128](0128-constrained-actor-api.md)).
- **Concurrency.** `concurrency` bounds the open attempts of one declaration per shard; waiting jobs start in start order. A store-wide bound is not offered in 0.2.0.
- **External effects are at least once.** A step that crashes mid-effect runs again. Steps SHOULD pass a provider idempotency key built from `ctx.id()` or the job id and step name. Akter never claims exactly-once external I/O.
- **Durable sleep.** `DurableClock.sleep` in a job schedules on the timer wheel. `DurableDeferred`, `Workflow.withCompensation` and `Workflow.addFinalizer` are not exposed in 0.2.0.
- **Events from jobs.** `emit.<event>(value)` in a job publishes at once; such events are progress, not facts: they are not in the log, may repeat if the job body replays, and are never replayed to late subscribers ([ADR 0130](0130-views-sessions-events-and-rpc.md)).

### 2. Cancellation is removed in 0.2.0

There is no `cancelJob`, no `onCancelled`, no `WorkflowRun.interrupt` and no cancel-by-key. A started job ends in success or in `onFailure`. An application that must stop work records the decision in state and the job reads it through an action call between steps. Removing the API is deliberate: 0.1's cancellation needed a separate outcome type (`Succeeded`, `Failed`, `Unknown`) and its own failure tests, and no 0.2.0 example needs it. A later ADR may add cancel-by-key with an explicit outcome.

### 3. `ShardWorkflowEngine`

Jobs compile to Effect workflows run by `ShardWorkflowEngine`, Akter's implementation of `WorkflowEngine`, built on `WorkflowEngine.makeUnsafe`, that journals `JobStarted`, `JobStep` and `JobFinished` entries through the owning shard's committer, so job progress shares the shard's fence and durability. Running executions live in a `FiberMap` keyed by job id. Effect Cluster's `ClusterWorkflowEngine` is not used ([ADR 0135](0135-effect-primitive-inventory.md)). The 4.0.3 adapter (`WorkflowEngine.makeUnsafe` over encoded members) is spiked in E1 and settled in E5; any `Unsafe` or non-exported API it needs is recorded in the spike report.

### 4. The timer wheel

- Each shard keeps a timer wheel in memory and in its checkpoint. `ctx.schedule(durationOrDate).<action>(payload)` adds a timer as an effect of the durable entry. Firing appends a `Fired` entry and runs the action with a command id derived from the timer id, as `System({ source: "timer", ref: <actor>, onBehalfOf })`.
- A timer is never dropped. A timer due while its shard is closed fires when the shard next opens, late, with its original due time recorded.
- **`nextDue`.** Every checkpoint manifest, including the drain-time one, records the earliest due instant of the shard. The drain report carries it per shard, so a host that stops a store can wake it in time. Self-hosted, a stopped store's timers fire when a runner next opens the shard.

### 5. Cron

- `Actor.action({ cron })` makes an action recurring. The action takes no payload and accepts only `System({ source: "cron" })`.
- A cron action runs on every actor of its type that has at least one durable action; the actor's first durable action schedules its first tick.
- The schedule string keeps 0.1's forms: a five- or six-field expression in UTC, `CRON_TZ=<IANA zone> <expression>` in a zone, or `@every <duration>` (at least one second, anchored to the Unix epoch). `Actor.make` rejects an unparsable string, an unknown zone or a fixed offset.
- Daylight saving follows [ADR 0042](0042-cron-time-zones-intervals-and-daylight-saving.md): a skipped wall-clock time fires once at the first instant after the gap; a repeated time fires once at its first occurrence; the rule depends only on the instant.
- Catch-up: each entry has at most one pending tick. After downtime the pending tick fires once if it is no older than `cronSkipIfOlderThan` (default 1 hour) and is skipped otherwise; either way the next tick is the first scheduled time after now. Missed ticks are never replayed one by one.

### 6. Job code across deploys

Job bodies follow Effect Workflow's replay model: finished steps return their journaled results; a renamed or removed step in a new build is an incompatibility. A shard whose open jobs name a declaration or step the running build does not have suspends those jobs (reported through inspection) and keeps serving everything else; it never fails them. A graceful drain leaves no running attempt behind; open jobs resume on the next owner from their journal ([ADR 0133](0133-build-matched-replay.md)).

## E2b amendment: durable cron catch-up

The catch-up threshold is inclusive: a pending tick exactly `cronSkipIfOlderThan` late (default one hour) fires once; only a tick older than the threshold is skipped. A skip is a durable `Skipped { commandId, at }` entry, which removes that pending tick and schedules the first tick after `at`. The state transition is replayed from the log; a crash must not resurrect a durably skipped tick, and days of downtime must not create a tick backlog.

E2b's ownership suite exercises recovery on both sides of the threshold and after days of downtime, while the real-store restart scenario recovers a pending one-shot timer. Engine drain checkpoints and reports `nextDue` per shard, with `null` for none. This does not establish cluster failover, DST (F15), a host waking a scaled-to-zero store (F27), or the E5 job guarantees; those remain their own milestones. Evidence and remaining boundary checks are in [E2 recovery](../verification/e2-recovery.md).

## Supersedes and amends

- Supersedes [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) — scope: §1 workflows on the framework engine and §3 effect routes.
- Supersedes [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) — scope: in full (relay, executor pool, singleton keepers and cron persistence).
- Supersedes [ADR 0022](0022-workflow-engine-storage-and-version-markers.md) — scope: in full; startup suspension of incompatible work carries as §6.
- Supersedes [ADR 0024](0024-effect-cancellation-and-per-actor-concurrency.md) — scope: in full; cancellation is removed (§2) and concurrency is restated (§1).
- Supersedes [ADR 0046](0046-workflow-engine-suite-drivers.md) — scope: in full.
- Amends [ADR 0042](0042-cron-time-zones-intervals-and-daylight-saving.md): schedule forms, DST and catch-up carry; tick keys and outbox rows end.
- Amends [ADR 0062](0062-scale-to-zero-serving.md): `nextDue` in the drain-time checkpoint and the drain report is how a scaled-to-zero store is woken.

## Alternatives

- **Keep a separate workflow member** beside jobs. Rejected by D23: one I/O mechanism.
- **Keep cancellation.** Rejected for 0.2.0 (§2); state-guarded jobs cover the examples.
- **Make `onFailure` optional.** Rejected: an exhausted job with nowhere to report is a silent loss; required routing makes failure visible in state.
- **Effect Cluster's `ClusterWorkflowEngine`, `ClusterCron` and `DeliverAt`.** Rejected (D24): they persist through Cluster message storage, a second durable store.
- **Store-wide job concurrency.** Rejected for 0.2.0: it needs coordination across shard owners; per-shard bounds are deterministic and replayable.
- **Replay missed cron ticks.** Rejected, as in 0.1: a store that wakes after a week should not run a week of ticks.

## Consequences

- Every wait (LLM calls, mail, payments, retries, sleeps) is a job; actions stay CPU-only.
- A job's calls into actors are idempotent by construction, closing the crash window between a durable call and its journal entry.
- Applications that used 0.1 cancellation model it in state.
- Job concurrency scales with shard count; documentation must say so.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1        | Spike: `ShardWorkflowEngine` journaling to the memory log passes `WorkflowEngine.layerMemory`'s behaviors; every `Unsafe` API recorded                                                                                                                                                           |
| E3        | F14 (timer due during failover), F15 (cron tick across a DST change), F27 (timer due while the store is scaled to zero fires on reopen)                                                                                                                                                          |
| E5        | F17 (crash inside a step; after a step before its journal entry is durable), F17′ (crash after a job's actor call is durable, before the job journals it: one effect), F18 (retries exhausted reach `onFailure` with `ambiguous` set correctly), F19 (concurrency under load across many actors) |

## Revisit when

- An application needs cancellation, approval waits (`DurableDeferred`) or compensation; each needs journal entry kinds and failure tests.
- Store-wide concurrency is required by a provider rate limit that per-shard bounds cannot express.
- The E1 spike shows `WorkflowEngine` cannot be adapted without unstable internals.
