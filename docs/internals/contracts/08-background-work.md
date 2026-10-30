# Jobs, timers and cron

Status: partially normative (0.2), owned by ADR 0129. E5 promotes the job journal, retries, failure delivery, concurrency, durable sleep and derived-call clauses in [E5 jobs](../verification/e5-jobs.md). E2b promotes pending-timer recovery, drain-time `nextDue` and persisted cron catch-up in [E2 recovery](../verification/e2-recovery.md). [E3 cluster evidence](../verification/e3-cluster.md) adds routed job calls and retirement, the scoped timer wheel, split-owner recovery, attribution, DST and no-runner restart. Cloud's proactive wake orchestration and the complete cross-build inspection path retain proposal status for E6/E8.

**Responsibility:** define how I/O runs, how timers and recurring commands fire, and what survives crashes, owner changes, deploys and scale to zero.  
**Authority:** normative 0.2 target on `main`.  
**Owner role:** runtime.  
**Change policy:** every change needs crash-point tests around journal durability and owner moves.

## Jobs

- Jobs are the only place for I/O. A job is declared with `Actor.job({ payload?, concurrency?, onSuccess?, onFailure })`; `onFailure` and `onSuccess` MUST name internal commands of the same actor, and `Actor.make` MUST refuse any other. Retry and timeout are policies attached with `.pipe(Job.retry({ times, schedule? }), Job.timeout(duration))`; they are not options of `Actor.job`.
- A job MUST start only after the segment of the command that staged it (`ctx.start.<job>`) is durable, and MUST NOT start if that command is discarded.
- **Job id.** With a `key`, the job id MUST be derived from the actor address, the declaration and the key, and at most one job with that id MAY be open; a start whose id is open MUST be recorded and ignored. Without a key, the id MUST be derived from the starting command id and the start's ordinal.
- **Steps.** `step(name, effect)` accepts a JSON-encodable or void result; `step(name, schema, effect)` encodes other results with a service-free Schema. A success MUST be journaled (`Step`) in the owning shard's log before the job proceeds past it. A step whose result is journaled MUST NOT run again, on replay, on a deliberate retry or on another owner. Step names MUST be static, unique, nonempty and not `body` or contain NUL; these names reserve the call-journal namespace.
- **Calls.** A job's actor calls MUST carry command ids derived from the job id, the enclosing step name or `body`, the attempt and the ordinal within that scope, and MUST be journaled with their replies. Concurrent calls within one scope MUST sit in distinct steps. A finished call MUST NOT be resent on replay. A call whose reply was not journaled MUST be resent with the same id by a crash replay of the same attempt and MUST receive the original outcome, which the per-job stream keeps until the job completes ([durability](03-durability.md)); a new attempt derives fresh ids.
- Calls from a job MUST run as `System({ source: "job", ref: <owning actor>, onBehalfOf })`.
- **Retries.** A failed, defective or timed-out attempt MUST be retried as a new attempt until `times` retries after the first attempt are spent or the policy's `schedule` ends, whichever comes first; a job without `Job.retry` makes one attempt. A crash or owner change MUST resume the same attempt. Journaled steps are not rerun. Jobs MUST NOT expose `withCompensation` or `addFinalizer` in 0.2.0.
- **Retry delay.** The delay before retry `n` MUST be the `n`th delay of a fresh run of the schedule, stepped at the failure time, and zero without a schedule. The failure entry (`JobFailed`) MUST journal the absolute deadline (`retryAt`) and whether retries stop there (`final`), so replay and owner moves never step the schedule again. A `JobFailed` entry without `final`, as written by 0.2, MUST stop when its attempt exceeds `times`.
- An attempt's failure, ambiguity and absolute retry deadline MUST be durable before waiting or delivering `onFailure`. An attempt's timeout starts at its durable `Attempt.at` and MUST NOT restart on owner movement. A running step interrupted before its success is durable MAY execute again; its provider idempotency key SHOULD be `ctx.id()` inside that step. Provider ids are derived from job, scope and ordinal and are stable across retries, independently of the actor-call ids that include the attempt.
- **`onFailure`.** When attempts are spent, the engine MUST deliver `Actor.JobFailure { job, declaration, payload, attempts, cause, ambiguous }` to the `onFailure` command exactly once, with `cause` one of `Failed`, `Defect` or `Timeout`, and `ambiguous` true when the last running step may have reached its provider. Only a typed failure returned by the step means the provider did not apply the call.
- **`onSuccess`.** When an attempt succeeds and the job declares `onSuccess`, its success value MUST be journaled as an internal step, encoded with that command's payload schema, before the job proceeds. The engine MUST then deliver the journaled value to `onSuccess` under the command id derived from the job id and `onSuccess`, as the job's `System` caller, before the job is `Done`. Replay of a job whose success value is journaled MUST deliver that value and MUST NOT run the handler again; a crash before or after delivery MUST leave exactly one application on the receiver. A declared failure or defect of the `onSuccess` command MUST be recorded on the receiver and MUST NOT fail, retry or keep open the job. A job without `onSuccess` MUST behave as in 0.2.
- **External effects are at least once.** A step that crashed mid-effect MUST run again on retry. Documentation MUST NOT claim exactly-once external I/O. Steps SHOULD use a provider idempotency key derived from the job (`ctx.id()`, or the job id and step name).
- **Concurrency.** `concurrency` MUST bound the open attempts of one declaration per shard; waiting jobs start in start order.
- **Accepted work continues.** A started job MUST continue after its originating caller loses access or its external id expires.
- **No cancellation in 0.2.0.** There is no cancel API, `onCancelled` route or run handle. A started job ends in success, delivered to `onSuccess` when it declares one, or in `onFailure`.
- Job state (the job table and journals) MUST be part of every checkpoint and MUST move with its shard. Open jobs MUST resume on the next owner from their journal.
- **Durable sleep.** `DurableClock.sleep({ name, duration })` from `@rikalabs/akter/server` MUST journal the absolute deadline even for a short sleep. Pending job clocks MUST contribute to the checkpoint's and drain report's `nextDue`. A replay MUST use the original deadline, not sleep the original duration again. `Effect.sleep` remains a local, nondurable wait.
- Completing a job MUST retain a durable cleanup obligation until the receiver call streams have retired. A crash between `Done`, receiver `Retired` entries and `JobRetired` MUST resume cleanup without rerunning the job body or its success or failure command.
- Job broadcasts are nondurable progress. They MAY repeat on a retry, MUST NOT enter the durable command-effects journal and MUST NOT be replayed to later subscribers. A final state update is an actor call, not a progress broadcast.

## Runner usage attribution

- `Telemetry.usage` from the server entry MUST read monotonic totals since the runner opened, grouped by declared actor type. Reading MUST NOT reset or seal them. Shard recovery or release MUST NOT reset them; another runner starts its own totals at zero. These counters are attribution, never storage or billing authority.
- `actions` MUST count only successful commands after their segment append is confirmed durable on this runner. Recovery/tail replay, `PageMiss` reruns, simulator double runs, deduplication answers, declared failures, defects, and appends resolved as unwritten MUST add zero. A lost response resolved by the segment identity as written MUST count once.
- `jobSeconds` MUST count locally executed, durably admitted attempts from local execution start through settlement (success, failure, defect or timeout), with elapsed wall time rounded up separately per attempt. Queue time and retry backoff MUST NOT count. Drain or owner loss MUST settle the local interval before scope closure; resumption counts only the new owner's interval and rounds that interval independently. Active attempts MUST NOT contribute speculative elapsed totals before settlement.
- The drain report MUST include the settled totals, including interrupted attempts and work on shards already released or lost. The wire fields are optional for legacy decoders. A process killed without finalizers or a write made durable just before process death MAY leave an attribution gap; recovery MUST NOT reconstruct counters by billing replay. The host reconciles gaps against platform-observed evidence.

Evidence: [E8a usage](../verification/e8a-usage.md).

## Timers

- A timer staged by `ctx.schedule` MUST become durable with its command. Firing MUST append an `Action` with `Fired` origin and run the target command under the timer's derived command id, as `System({ source: "timer", ref: <actor>, onBehalfOf })`. The pending record and checkpoint MUST retain that originating principal.
- A timer MUST fire at most once and MUST NOT be dropped. A timer due while its shard has no owner MUST fire when the shard next opens, late, with its original due time recorded.
- Every checkpoint, including the drain-time one, MUST record the shard's `nextDue`, and the drain report MUST list it per shard so a host can wake a stopped store.
- A temporary failure to verify an expired lease MUST NOT leave a due timer marked armed forever. The attempt retries with the same id while its shard remains open; a closed shard's next owner rebuilds pending wakeups from the durable records.

## Cron

- `Actor.command({ cron })` MUST make a command recurring. The command MUST take no payload and MUST accept only `System({ source: "cron" })`.
- A cron command MUST run on every actor of its type that has at least one durable command; the actor's first durable command schedules its first tick.
- The schedule MUST be one of: a five- or six-field expression in UTC; `CRON_TZ=<IANA zone> <expression>`; or `@every <duration>` of at least one second, anchored to the Unix epoch. An unparsable schedule, an unknown zone or a fixed offset MUST be refused by `Actor.make`.
- In a zone, a wall-clock time skipped by a transition MUST fire once at the first instant after the gap, and a repeated time MUST fire once at its first occurrence. The rule depends only on the instant.
- Each cron entry MUST have at most one pending tick. After downtime the pending tick MUST fire once if it is no older than `cronSkipIfOlderThan` (default 1 hour, inclusive at exactly one hour) and be skipped otherwise; the next tick is the first scheduled time after now. A skip MUST be durable as `Skipped`. Missed ticks MUST NOT be replayed one by one.

## Deploys

A shard whose open jobs name a declaration or step that the running build lacks MUST suspend those jobs, report them through inspection, and keep serving everything else. It MUST NOT fail them.

## Verification

F14 (timer due during failover), F15 (cron across a DST change), F17 (crash inside a step; after a step before its journal entry is durable), F17′ (crash after a job's call is durable, before it is journaled: one effect), F18 (retries exhausted reach `onFailure` with the right `ambiguous`), F19 (concurrency under load), success delivery (a crash after the success value is journaled and after its delivery each apply `onSuccess` once, a handler that differs between runs delivers its journaled value, and a declared failure of `onSuccess` completes the job), retry policies (an exponential schedule journals 2s then 4s, `times` bounds attempts, an ending schedule stops early, a crash between failure and retry keeps the journaled deadline, a 0.2 `JobFailed` without `final` stops by `times`, and a piped timeout reports `Timeout`), F27 (timer due while the store is scaled to zero). [E3 cluster evidence](../verification/e3-cluster.md) separates simulator, scoped clock/DST and process restart evidence; it does not claim that the Cloud control plane already schedules wakes.
