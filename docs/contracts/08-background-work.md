# Jobs, timers and cron

Status: proposal (0.2), owned by ADR 0129; promoted when E3 (timers and cron) and E5 (jobs) failure evidence lands, each section with its milestone.

**Responsibility:** define how I/O runs, how timers and recurring actions fire, and what survives crashes, owner changes, deploys and scale to zero.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** runtime.  
**Change policy:** every change needs crash-point tests around journal durability and owner moves.

## Jobs

- Jobs are the only place for I/O. A job is declared with `Actor.job({ payload, retry?, timeout?, concurrency?, onFailure })`; `onFailure` MUST name an action of the same actor.
- A job MUST start only after the segment of the action that staged it (`ctx.start.<job>`) is durable, and MUST NOT start if that action is discarded.
- **Job id.** With a `key`, the job id MUST be derived from the actor address, the declaration and the key, and at most one job with that id MAY be open; a start whose id is open MUST be recorded and ignored. Without a key, the id MUST be derived from the starting command id and the start's ordinal.
- **Steps.** A step's result MUST be journaled (`JobStep`) in the owning shard's log before the job proceeds past it. A step whose result is journaled MUST NOT run again, on replay or on another owner. Step names MUST be static and unique within a job body.
- **Calls.** A job's actor calls MUST carry command ids derived from the job id, the enclosing step name or `body`, the attempt and the ordinal within that scope, and MUST be journaled with their replies. Concurrent calls within one scope MUST sit in distinct steps. A finished call MUST NOT be resent on replay. A call whose reply was not journaled MUST be resent with the same id by a crash replay of the same attempt and MUST receive the original outcome, which the per-job stream keeps until the job completes ([durability](03-durability.md)); a new attempt derives fresh ids.
- Calls from a job MUST run as `System({ source: "job", ref: <owning actor>, onBehalfOf })`.
- **Retries.** A failed, defective or timed-out attempt MUST be retried as a new attempt with the declared backoff until `retry.attempts` is spent; a crash or owner change MUST resume the same attempt. Journaled steps are not rerun. Jobs MUST NOT expose `withCompensation` or `addFinalizer` in 0.2.0.
- **`onFailure`.** When attempts are spent, the engine MUST deliver `Actor.JobFailure { job, declaration, payload, attempts, cause, ambiguous }` to the `onFailure` action exactly once, with `cause` one of `Failed`, `Defect` or `Timeout`, and `ambiguous` true when the last running step may have reached its provider. Only a typed failure returned by the step means the provider did not apply the call.
- **External effects are at least once.** A step that crashed mid-effect MUST run again on retry. Documentation MUST NOT claim exactly-once external I/O. Steps SHOULD use a provider idempotency key derived from the job (`ctx.id()`, or the job id and step name).
- **Concurrency.** `concurrency` MUST bound the open attempts of one declaration per shard; waiting jobs start in start order.
- **Accepted work continues.** A started job MUST continue after its originating caller loses access or its external id expires.
- **No cancellation in 0.2.0.** There is no cancel API, `onCancelled` route or run handle. A started job ends in success or in `onFailure`.
- Job state (the job table and journals) MUST be part of every checkpoint and MUST move with its shard. Open jobs MUST resume on the next owner from their journal.

## Timers

- A timer staged by `ctx.schedule` MUST become durable with its action. Firing MUST append a `Fired` entry and run the target action with a command id derived from the timer id, as `System({ source: "timer", ref: <actor>, onBehalfOf })`.
- A timer MUST fire at most once and MUST NOT be dropped. A timer due while its shard has no owner MUST fire when the shard next opens, late, with its original due time recorded.
- Every checkpoint, including the drain-time one, MUST record the shard's `nextDue`, and the drain report MUST list it per shard so a host can wake a stopped store.

## Cron

- `Actor.action({ cron })` MUST make an action recurring. The action MUST take no payload and MUST accept only `System({ source: "cron" })`.
- A cron action MUST run on every actor of its type that has at least one durable action; the actor's first durable action schedules its first tick.
- The schedule MUST be one of: a five- or six-field expression in UTC; `CRON_TZ=<IANA zone> <expression>`; or `@every <duration>` of at least one second, anchored to the Unix epoch. An unparsable schedule, an unknown zone or a fixed offset MUST be refused by `Actor.make`.
- In a zone, a wall-clock time skipped by a transition MUST fire once at the first instant after the gap, and a repeated time MUST fire once at its first occurrence. The rule depends only on the instant.
- Each cron entry MUST have at most one pending tick. After downtime the pending tick MUST fire once if it is no older than `cronSkipIfOlderThan` (default 1 hour) and be skipped otherwise; the next tick is the first scheduled time after now. Missed ticks MUST NOT be replayed one by one.

## Deploys

A shard whose open jobs name a declaration or step that the running build lacks MUST suspend those jobs, report them through inspection, and keep serving everything else. It MUST NOT fail them.

## Verification

F14 (timer due during failover), F15 (cron across a DST change), F17 (crash inside a step; after a step before its journal entry is durable), F17′ (crash after a job's call is durable, before it is journaled: one effect), F18 (retries exhausted reach `onFailure` with the right `ambiguous`), F19 (concurrency under load), F27 (timer due while the store is scaled to zero).
