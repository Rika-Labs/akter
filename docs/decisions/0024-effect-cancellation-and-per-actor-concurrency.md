# ADR 0024: Effect cancellation and per-actor effect concurrency

**Status:** proposed (2026-09-26)

## Context

[Contract 08](../contracts/08-background-work.md) says effect cancellation and per-actor effect concurrency caps are not provided and that a performed effect cannot be withdrawn after its turn commits. Two general needs are unmet:

- **Cancelling work that is no longer wanted.** A signup schedules a reminder email and the user confirms first; an order books a courier and is then cancelled; a chat room asks a moderation service to review a message the author then deletes. Today the actor has to let the call run and ignore its route.
- **Bounding concurrent calls per actor.** A chat room that fans out moderation calls, a payment account that must not have two captures in flight, or an import that streams rows to a rate-limited provider need "at most n calls for this actor at once". Today the only bound is the per-runner executor pool (`executors.concurrency`, [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)), and with several runners one actor can have up to `runners × concurrency` calls in flight.

The mechanism this ADR builds on is ADR 0021's (accepted, built in M2.4):

- An effect is an `actor_outbox` row of `kind = 'effect'` on the performing actor's shard. Any runner with the effect's executor claims it with `FOR UPDATE SKIP LOCKED`; the claim increments `attempts`, sets `ambiguous = true`, and moves `due_at_ms` to the end of an executor lease.
- The executor runs outside any transaction in the claiming runner's pool. The pool renews the lease every `lease / 3` with an `attempts = n` guard, interrupts the attempt when a renewal matches no row or its local lease deadline passes, and another runner may then claim attempt `n + 1`. Attempts can overlap after a lease loss.
- The first success of any attempt wins: its settle statement is guarded on `kind = 'effect'` only and turns the row into an intent to `onSuccess` (or deletes it). A failure keeps the `attempts = n` guard. A success after the dead letter marks the dead letter `ambiguous`.
- Only a typed executor failure means "the provider did not apply the call". A defect, timeout, interruption, lease loss, or crash leaves the outcome unknown, and invariant **P1** forbids treating an unknown outcome as a failure.

[ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) §3 requires a route's input to match what it receives: `onSuccess` takes the executor's return type and `onDeadLetter` takes `Actor.DeadLetter(E)`. [Contract 05](../contracts/05-messaging.md) gives keyed intents the model this ADR mirrors: `Intent.key` names a pending row within its sender, and `Intent.cancel(key)` deletes it in the cancelling turn, while a timer already firing is delivered once.

What is missing is a durable way to tell a claimed row from one that is backing off (both have `attempts > 0` and `due_at_ms` in the future), a durable cancellation request that a running attempt and its settle can see, and a cap that holds across runners.

## Decision

### 1. Keyed effects

`turn.perform(effect, options?)` gains options:

```ts
yield * turn.perform(SendReminder.make({ userId }), { key: "reminder", after: "24 hours" })
yield * turn.perform(Capture.make({ paymentId, amount }), { key: `capture:${paymentId}` })
```

- `key` names the effect within its performing actor, like `Intent.key`. Keys live in their own namespace: they are stored in `actor_outbox.timer_key` with the reserved prefix `$effect:`, so an effect key and an intent key with the same text never collide, and the existing unique index on `(routing_key, tenant_id, actor_type, actor_id, timer_key)` keeps one row per key. `Intent.key` and `Intent.cancel` with a `$effect:` key die with `Intent key "$effect:…" is reserved for effects`, as `$cron:` does today.
- `after` and `at` delay the first attempt, like `Intent.after` and `Intent.at`, and use the database clock. A delayed effect is what makes "cancel the reminder" useful; without a delay, a pending effect usually exists only until the next relay pass.
- Performing again with a key that names an existing effect of this actor cancels that effect by the rules of section 2 and then records the new one, in the same commit. The new effect gets a new effect id; ids are never reused.
- An unkeyed `turn.perform(effect)` is unchanged.

### 2. Cancellation

`turn.cancelEffect(key)` is an `X.Turn` capability, like `perform`. It is staged and applied in the turn's commit statement, so a turn that declares a failure, defects, or rolls back cancels nothing. A captured `cancelEffect` run after its turn dies with `Effect capability escaped its turn`. Cancelling a key that names no effect row does nothing, which is also what happens after the effect has completed.

The commit statement applies it to the row by state. The state is read from the row under its row lock, in the same statement, so a concurrent claim either happened before (and the row is running) or will skip the locked row and then find it gone:

| Row state at the cancelling commit                                                              | Result                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pending, never attempted** (`attempts = 0`)                                                   | The row is deleted. The executor never runs; no route and no dead letter.                                                                                                                                                                                                                                                            |
| **Backing off after an attempt** (`attempts > 0`, not running)                                  | The row becomes an intent to `onCancelled` in the same statement (section 3) with the recorded outcome: `Failed` only if every attempt so far reported a typed failure (`maybe_applied` is false and the last attempt failed with a typed error), otherwise `Unknown` with `ambiguous: true`. It is never attempted again.           |
| **Running** (claimed, lease live)                                                               | The row is marked cancelled (`cancelled_at_ms`), and its key is released so a new effect may take it. It is not deleted: the attempt may already have reached the provider. The executor is interrupted best-effort (section 4) and the row settles as cancelled with whatever the attempt reports (section 3). It is never retried. |
| **Running, lease expired** (the claiming runner died or was partitioned)                        | Marked cancelled as above. Its lease has ended, so no attempt is running; the next runner with the executor that finds it due settles it as cancelled with `Unknown`, `ambiguous: true`, without running the executor.                                                                                                               |
| **Completed** (the row already became its `onSuccess` or `onDeadLetter` intent, or was deleted) | Nothing changes. Route intents never carry an effect key, so `cancelEffect` cannot delete a route. The route is delivered once as before; a handler that must ignore it checks actor state, as for a firing timer.                                                                                                                   |

A cancelled effect whose provider call may have happened is reported as ambiguous. It is never retried, and it is never dropped without a trace: a cancelled row that has been attempted always ends as an `onCancelled` intent, or, without `onCancelled`, by the fallback in section 3. Cancellation never undoes a provider call, and the framework does not ask the provider to undo it; compensation, such as refunding a captured payment, is the application's job, driven by the `onCancelled` route.

### 3. `onCancelled` route and the cancelled outcome

`policy.effects[Tag]` gains `onCancelled`, a command in `api` or `internal` whose input must accept `Actor.Cancelled(E)`:

```ts
// Actor.Cancelled(E)
{
  effectId: string
  effect: E
  attempts: number
  outcome:
    | { _tag: "Succeeded"; value: E["success"] } // the provider applied the call
    | { _tag: "Failed"; cause: string }           // typed failure: the provider did not apply it
    | { _tag: "Unknown"; cause: string }          // interrupted, timed out, defect, lease lost, or crash
  ambiguous: boolean                               // true exactly when outcome is Unknown
}
```

A separate route keeps ADR 0012's rule that `onSuccess` receives the executor's return type: a cancelled-then-succeeded result is not an `onSuccess`, because the actor asked for it not to happen, and a flag on `onSuccess` would change its input type for every effect.

Settling a cancelled row:

- The settle statement is ADR 0021's, with one more branch. A success still wins only while the row is an effect; if the row's `cancelled_at_ms` is set, the same statement turns it into an intent to `onCancelled` with `Succeeded` instead of to `onSuccess`. A success that cannot be encoded under `E`'s `success` schema is reported as `Unknown`, as the uncancelled path already dead-letters it as `ambiguous`.
- A typed failure of the running attempt settles as `Failed` only when no earlier attempt of the effect may have applied the call (`maybe_applied` is false); otherwise it settles as `Unknown` with `ambiguous: true`, because a later typed failure proves nothing about an earlier unreported attempt. An interruption, timeout, defect, or lost lease settles as `Unknown` with `ambiguous: true`. These keep ADR 0021's `attempts = n` guard, so a stale attempt's failure cannot overwrite a newer outcome.
- A cancelled row is never claimed for another attempt: the attempt claim adds `cancelled_at_ms IS NULL`. A cancelled row whose lease has passed is claimed by a separate settle-only claim on runners that have the executor, which settles it as `Unknown` without running anything.
- The route is delivered once, like `onSuccess`: its command id is the effect id and its caller is `System({ source: "effect", ref: <actor>, onBehalfOf: <performing turn's principal> })`.
- A success from an attempt that lost its lease and arrives after the row settled as cancelled matches no effect row. As with a success after a dead letter, the pool records the fact where operators can see it: it writes an `actor_dead_letters` row for the effect (cause `Succeeded after it was cancelled`, `ambiguous: true`) if none exists, marks an existing one `ambiguous`, and logs `Effect succeeded after it was cancelled`. The routed `Actor.Cancelled` input is not changed.

Without `onCancelled`, outcomes still reach the actor or operators:

- `Succeeded` routes to `onSuccess`, because the provider applied the call and the result must not be lost; without `onSuccess` the row is deleted as today.
- `Unknown` is dead-lettered: an `actor_dead_letters` row with `ambiguous: true` and cause `Cancelled while attempt n was running: …`, then `onDeadLetter` if declared, with `Actor.DeadLetter(E)` input unchanged.
- `Failed` deletes the row and logs `Effect cancelled after a failed attempt`; the provider did not apply the call.

`Actor.make` warns once at startup for a keyed effect type with neither `onCancelled` nor `onDeadLetter`, because an ambiguous cancellation would then be visible only to operators.

### 4. Interrupting a running attempt

The pool's lease renewal (`UPDATE … SET due_at_ms = $now + $lease WHERE … AND attempts = $n`) returns `cancelled_at_ms`. When it is set, the pool interrupts the executor fiber, awaits it, and settles with whatever it reported; an executor that finishes before the interruption lands reports its real outcome. The same check runs when the cancelling turn commits on the runner that holds the attempt (a local post-commit wake, as for intents). There is no runner-to-runner wake, as in ADR 0021, so on another runner cancellation reaches a running attempt within `lease / 3` (20 s with the default lease). `executors.cancelCheck` (default `lease / 3`, at least 1 second) lets a deployment check more often, at one statement per running attempt per check.

Interruption is best effort. An executor that is inside a provider call when it is interrupted may have sent it, which is exactly why that outcome is `Unknown`.

### 5. Per-actor concurrency caps

`policy.effects[Tag].concurrency: { perActor: n }` (an integer from 1 to 64) bounds the attempts of that effect type for one actor that hold a live lease, across every runner:

```ts
policy: {
  effects: {
    ModerateMessage: { retry: { times: 5 }, concurrency: { perActor: 2 }, onSuccess: Moderated },
    CapturePayment: { concurrency: { perActor: 1 }, onSuccess: Captured, onDeadLetter: CaptureFailed },
  },
}
```

- **What counts.** A row counts while it is running: from its claim until its settle, or until its lease ends if its runner dies. A backing-off row, a pending row, and a row whose lease has expired do not count. A cancelled row counts until it settles, because its attempt may still be calling the provider. The pool's local deadline interrupts an attempt before the database lease can end (ADR 0021), so at most `n` executor fibers for one actor and effect type are running at any time, up to interruption latency.
- **Scope.** The cap is per `(tenant, actor type, actor id, effect tag)`. Effects of other tags on the same actor, and the same tag on other actors, are not affected.
- **Enforcement across runners.** Uncapped effects keep ADR 0021's claim unchanged. For capped effect types, the claim runs as one short transaction per candidate actor: it takes `pg_advisory_xact_lock` on a 64-bit hash of `(tenant, actor type, actor id, tag)`, counts running rows, and claims at most `n − running` of that actor's due rows with `FOR UPDATE SKIP LOCKED`. The authority is the durable running rows the claim counts; the advisory lock only serializes two runners' checks for one actor, lasts for one statement pair, and never spans an executor call. A runner that dies with the lock simply rolls back.
- **Rows waiting at the cap.** A due row that cannot be claimed because its actor is at the cap is moved out of the due range (`due_at_ms = now + executors.lease`, no attempt counted), so waiting rows never fill a runner's candidate scan and starve other actors. Every settle of a capped row, in its settle statement, makes the oldest waiting row of the same actor and tag, by `(ready_at_ms, intent_id)`, due now. The lease-length fallback covers a runner that died holding a slot.
- **Order.** Rows of one actor and tag are claimed in `(ready_at_ms, intent_id)` order, where `ready_at_ms` is the time the row first became due and never moves when the row waits at the cap. Deferring a waiting row therefore never lets a newer effect overtake it, so waiting work runs first in, first out even while new effects keep arriving. An attempt that backs off after a failure keeps its `ready_at_ms` and runs ahead of newer rows once its backoff ends.

A **deployment-wide** limit per effect type (for example "at most 50 calls to this provider across the fleet") is **not** in this ADR. It would be a database-wide serialization point, which [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) prohibits, and provider rate limits are usually per credential rather than per effect type. A per-runner bound already exists (`executors.concurrency`), and an executor layer can apply a per-runner Effect rate limiter to its provider client. A fleet-wide quota needs its own ADR with a design that does not serialize on one row.

### 6. Storage: migration `0015_effect_control` is used

Cancellation and caps need to tell a running attempt from a row that is backing off, and a running attempt needs a durable cancellation request it can see at renewal and at settle. The existing columns cannot carry either: both states have `attempts > 0` and a future `due_at_ms`, and `ambiguous` and `last_error` describe the last outcome, not the current claim. ADR 0021 rejected a separate lease column because the due scan would need a second predicate; the columns below are not read by the due scan.

```sql
ALTER TABLE actor_outbox
  ADD COLUMN running boolean NOT NULL DEFAULT false,
  ADD COLUMN cancelled_at_ms bigint,
  ADD COLUMN maybe_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN ready_at_ms bigint;

UPDATE actor_outbox
  SET ready_at_ms = due_at_ms,
      maybe_applied = attempts > 0 AND ambiguous,
      running = attempts > 0 AND ambiguous
        AND last_error = format('Attempt %s ended without reporting an outcome', attempts)
        AND due_at_ms > (extract(epoch FROM clock_timestamp()) * 1000)::bigint
  WHERE kind = 'effect';

-- per-actor cap counts; holds only claimed effect rows
CREATE INDEX actor_outbox_running
  ON actor_outbox (routing_key, tenant_id, actor_type, actor_id, command)
  WHERE kind = 'effect' AND running;
```

- The attempt claim sets `running = true`. Every settle (success, failure, cancellation, dead letter) sets it to `false` or removes the row. A row whose runner died keeps `running = true` with an expired `due_at_ms`; the cap counts `running AND due_at_ms > now`, so a dead runner's slot frees when its lease ends.
- **Rolling upgrade.** The backfill marks rows that a pre-0015 runner has claimed under a live lease as `running`, so the first cancellation cannot mistake them for idle rows. The claim is recognized by the `last_error` marker it writes (`Attempt n ended without reporting an outcome`). Every reported outcome overwrites that marker, so an effect backing off after an unknown outcome is also `ambiguous` with a future `due_at_ms`, yet is not marked running and holds no cap slot. If M2.4 changes the claim's marker, M2.13 matches the backfill to the claim that shipped. A pre-0015 runner that claims after the migration would not set `running`, so pre-0015 runners must run without executors, or be stopped, from the migration until every runner has the M2.13 code. Under ADR 0021 an executor-less runner never claims effects, so this needs no new mechanism. The M2.13 release notes state the order.
- `maybe_applied` is sticky: an attempt claim that finds the previous attempt unreported (`attempts > 0 AND ambiguous`, so its lease ended without a settle) sets it, and nothing clears it. Cancellation and cancelled settles read it so that one possibly applied attempt makes the whole effect `Unknown`.
- `ready_at_ms` is set once, to the row's first due time, when the effect is performed; waiting at the cap and backoff never change it. It is read only by the capped claim and the settle's wake.
- `cancelled_at_ms` is written only by a cancelling commit and read by renewals, settles, and the attempt claim's `cancelled_at_ms IS NULL` filter.
- Keys reuse `timer_key` and its unique index, with the `$effect:` prefix. Dead letters reuse `actor_dead_letters`; `Actor.Cancelled` payloads are ordinary intent payloads. Neither needs a schema change.
- The migration adds nullable columns and columns with constant defaults, which rewrite no table on Postgres 11 or later, a partial index over a small set of rows, and a backfill that touches only pending effect rows.

### 7. Workflows and other work

Workflow activities are not effects. `wf.interrupt` and `WorkflowRun.interrupt` ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)) are unchanged, and `turn.cancelEffect` cannot target an activity. Intents and timers keep contract 05's cancellation rules.

## Alternatives rejected

- **Cancel by effect id.** `turn.cancelEffect(effectId)` would need the id to be stored in actor state first, and the id is not known to the turn until `perform` returns it. A key mirrors `Intent.key`, is known before the effect exists, and lets "perform again with the same key" replace one pending effect.
- **Delete the row on every cancellation.** A running attempt's result would match no row and be lost, and a provider call that happened would leave no trace: P1 and contract 08 forbid both.
- **Retry a cancelled effect whose attempt was interrupted, or skip it silently.** Retrying runs a call the actor withdrew; skipping hides a call that may have happened. Both are the silent ambiguity this ADR exists to prevent.
- **A `cancelled` flag on `onSuccess` or `onDeadLetter`.** It would change `onSuccess`'s input away from the executor's return type (ADR 0012 §3) and force every effect's success handler to handle a case most effects never have.
- **Undo by calling a declared compensation executor.** Compensation is domain logic (refund, void, retract), may itself fail or be ambiguous, and belongs in the `onCancelled` handler, which can perform a compensating effect with its own retries and routes.
- **Cap through a counter row per actor and tag.** Every claim and settle would update one hot row per actor, and a crash between claim and settle would leak a slot until an operator repaired it. Counting live leases self-heals when a lease ends.
- **Enforce the cap in the executor pool only.** Each runner knows only its own attempts, so three runners would allow `3n`.
- **Cap by `SERIALIZABLE` claims.** It would retry the whole claim batch on conflict and serialize uncapped effects that share a bucket.
- **A deployment-wide per-type limit now.** Rejected as above; a later ADR can add a sharded quota.
- **Cancellation reaching a running attempt through a runner-to-runner message.** ADR 0021 keeps wakes local; a lost message would still need the renewal check, so the message would only shorten the latency. It can be added later without changing semantics.

## Consequences

- An effect row has four observable fates instead of two: `onSuccess`, `onDeadLetter`, `onCancelled`, or deleted before any attempt. Every fate after an attempt is recorded durably.
- `onCancelled` handlers must handle `Succeeded` by compensating or accepting the result, and `Unknown` by reconciling with the provider, for example by looking up the `effectId` idempotency key.
- A cap delays work rather than rejecting it; a flood of performs on one capped actor grows its outbox, visible through the relay-lag signal that ADR 0021 defines, with the waiting rows' `scheduled_at_ms` preserved.
- The capped claim adds one short transaction per capped actor with due rows. Uncapped effects and intents pay nothing: their claim, turn commit, and statement counts are unchanged.
- The advisory lock depends on Postgres advisory locks. PGlite has them within its single process. Neki's support for `pg_advisory_xact_lock` is unverified, so caps stay gated there until the conformance cases pass on Neki.

## Behaviour changes against existing contracts

Each change is made in this ADR's pull request, in the document named, except where the row says it amends an accepted ADR, which stays unedited as the decisions index requires.

| Document                                                                                                                                                                                                 | Was                                                                                      | Becomes                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [08 background work](../contracts/08-background-work.md)                                                                                                                                                 | cancellation and per-actor caps are not provided; a performed effect cannot be withdrawn | Keyed effects, `turn.cancelEffect` by state, the `onCancelled` route and its fallback, never-retried cancelled attempts, per-actor caps across runners, and no deployment-wide limit. |
| 08 background work; amends ADR 0012 §3                                                                                                                                                                   | effect results reach `onSuccess` or `onDeadLetter`                                       | Also `onCancelled` with `Actor.Cancelled(E)` input. `onSuccess` and `onDeadLetter` keep their inputs.                                                                                 |
| 08 background work; amends ADR 0021's settle rule                                                                                                                                                        | the first success of any attempt is routed to `onSuccess`                                | The first success is routed to `onCancelled` when the row was cancelled; a success after a cancelled row settled marks or writes an ambiguous dead letter.                            |
| [05 messaging](../contracts/05-messaging.md)                                                                                                                                                             | `$cron:` is the reserved key prefix                                                      | `$effect:` is reserved too; effect keys share the sender's outbox key index but not intent keys' namespace.                                                                           |
| [09 recovery](../contracts/09-recovery.md)                                                                                                                                                               | a dead runner's effect attempt is retried or dead-lettered after its lease               | A cancelled one is settled as `Unknown` and never retried; a dead runner's cap slot frees at its lease end.                                                                           |
| [Server API](../api/01-server-api.md), [context](../api/02-context.md)                                                                                                                                   | `turn.perform(effect)`; no cancellation or caps                                          | `turn.perform(effect, { key, after, at })`, `turn.cancelEffect(key)`, `policy.effects[Tag].onCancelled`, `concurrency: { perActor }`, `executors.cancelCheck`, `Actor.Cancelled(E)`.  |
| [Data model](../architecture/data-model.md), [transaction catalog](../architecture/transaction-catalog.md)                                                                                               | `actor_outbox` has no claim state                                                        | `running`, `cancelled_at_ms`, `maybe_applied`, and `ready_at_ms` (migration `0015_effect_control`), and the capped claim transaction.                                                 |
| [Invariants](../verification/invariants.md), [failure matrix](../verification/02-failure-matrix.md), [conformance](../verification/01-conformance.md), [support matrix](../operations/support-matrix.md) | no cancellation or cap evidence                                                          | Invariant **P2** and the rows and cases below; support rows for cancellation and caps, target and unverified.                                                                         |

## Verification required of M2.13 (`conformance/effect-control.ts`, migration `0015_effect_control`)

Cases run on real Postgres with the in-process multi-runner harness; the single-runner ones also run on PGlite under the same names.

- `never runs an effect cancelled before its claim` — perform with `after: "1 hour"`, cancel in a later turn; advance past the delay: no attempt, no route, no dead letter, no row.
- `cancels nothing when the cancelling turn rolls back` — a declared failure, a defect, and a `beforeCommit` crash after `cancelEffect`; the effect runs and routes `onSuccess` once.
- `reports a running effect cancelled mid-call once and never retries it` — the executor blocks inside a fake provider; cancel on another runner; the attempt is interrupted within `cancelCheck`; `onCancelled` runs once with `Unknown` and `ambiguous: true`; no attempt 2 starts; `onSuccess` never runs.
- `routes a result that arrives after cancellation to onCancelled` — the executor ignores interruption and returns: `Succeeded` with the value, once; with a typed failure: `Failed`, `ambiguous: false`.
- `routes a success after cancellation to onSuccess when onCancelled is not declared` and `dead-letters an unknown cancelled outcome as ambiguous when onCancelled is not declared`.
- `does nothing when cancelling an effect that already completed` — `onSuccess` is delivered once; the key is free.
- `resolves a cancel racing a claim to exactly one fate` — 200 iterations with `pauseNext("afterClaim")` and the cancelling commit interleaved both ways: either no provider call and no route, or one report through `onCancelled`.
- `settles a cancelled effect whose runner was killed as ambiguous without running it` — kill the claiming runner mid-call, cancel, advance past the lease: `onCancelled` with `Unknown`, and the provider ledger shows one call.
- `reports a cancelled effect that was backing off with its recorded outcome` — one typed failure then cancel: `Failed`; one crashed attempt then cancel: `Unknown`; a lost-lease attempt followed by a typed failure, cancelled during backoff or during a third running attempt: `Unknown` and `ambiguous: true`.
- `claims capped rows oldest first while new effects keep arriving` — `perActor: 1`; A runs, B waits at the cap, C, D, … are performed while B waits; each settle claims the oldest waiting row, so B runs before C.
- `replaces a keyed effect performed again under the same key` — pending: the old one never runs; running: the old one is reported, the new one runs under a new effect id.
- `marks a lease-lost success that arrives after a cancelled settle as ambiguous`.
- `never runs more than perActor attempts for one actor across runners` — `perActor: 2`, 50 due effects on one actor, three runners, and one runner killed mid-test: the provider's in-flight high-water mark for that actor is 2, every effect routes once, and the killed runner's slot frees after its lease.
- `does not let an actor at its cap delay other actors' effects` — one actor with 1,000 waiting rows and `perActor: 1`; another actor's effect starts within one poll.
- `wakes the next waiting row when a capped attempt settles` — the next row is claimed within one poll after the settle, not after a lease.
- `rejects reserved and escaped effect keys` — `Intent.key("$effect:x")` dies; a captured `cancelEffect` dies with `Effect capability escaped its turn`.
- Declaration tests: `onCancelled` whose input does not accept `Actor.Cancelled(E)` does not compile; `perActor` outside 1–64 is rejected at `Actor.make`.
- Migration: `applies 0015_effect_control to a database that already ran 0014_connections`, and uncapped claims' `EXPLAIN` is unchanged.
- SIGKILL on Postgres: `recovers a SIGKILL afterExecute on a cancelled effect and reports it once`.

## Failure-matrix rows

| Fault point                                  | Required result                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect cancelled before claim                | The row is deleted in the cancelling commit; no runner claims it; no provider call, route, or dead letter.                                                                                                                      |
| Cancelling turn rolls back                   | The effect row is unchanged and later runs and routes as if never cancelled.                                                                                                                                                    |
| Effect cancelled while executing             | The row is marked cancelled and never attempted again; the attempt is interrupted within `cancelCheck`; exactly one `onCancelled` (or its fallback) reports the outcome, `Unknown` and `ambiguous` unless the attempt reported. |
| Effect result arrives after cancel           | A success routes once as `Succeeded` (or to `onSuccess` without `onCancelled`); a typed failure reports `Failed`; a success after the cancelled settle marks an ambiguous dead letter. No result is lost or routed twice.       |
| Runner killed while a cancelled attempt runs | After the lease, a runner with the executor settles it as `Unknown` without running it; the cap slot frees.                                                                                                                     |
| Cancel races the attempt claim               | Exactly one fate: deleted with no provider call, or claimed and reported.                                                                                                                                                       |
| Runner killed holding a capped slot          | Live leases for that actor and tag never exceed `perActor`; the slot frees at lease end and a waiting row is claimed.                                                                                                           |
| Two runners claim one capped actor at once   | The advisory lock serializes their counts; at most `perActor` rows are running.                                                                                                                                                 |

## Benchmark plan (`effect-concurrency`, M2.13)

This ADR is documentation only; there is nothing to measure until M2.13. M2.13 adds `tooling/benchmarks/src/scenarios/effect-concurrency.ts` and commits its results under `benchmarks/results/`:

- **Environment.** Real Postgres 18.6 in Docker on one host, three in-process runners, Bun 1.4.2; the result JSON records CPU, memory, and commit.
- **Workloads.** (a) 1,000 actors × 10 effects of a 50 ms fake provider, uncapped versus `perActor: 2`; (b) one hot actor with 1,000 effects and `perActor: 1` alongside 1,000 cold actors with one effect each; (c) 1,000 running effects cancelled from turns on another runner.
- **Measures.** Effect start latency (due → claim) p50/p95/p99; throughput in effects per second; the maximum in-flight attempts per actor observed by the fake provider (must be ≤ `perActor`); cancel-to-interrupt latency p50/p95/p99 with default and 1-second `cancelCheck`; statements and round trips per capped claim and per cancelling commit.
- **Repeats.** Five runs per configuration after one warm-up; report the median of each percentile and the coefficient of variation, and treat a difference under 2 × CoV as noise.
- **Statements gate.** Turn statement counts in `benchmarks/baselines/statements.json` must not change: a keyed perform and a cancel are part of the existing commit statement. Any change is explained in the M2.13 PR.

## Open questions for Dallen, with recommended defaults

**Q1. API spelling.** Default: `turn.perform(e, { key })` and `turn.cancelEffect(key)`. Alternative: `Effect.key`-style pipeable options like `Intent.key`. The options object is clearer because `perform` is a method, not a staged Effect that other combinators wrap.

```ts
yield * turn.perform(SendReminder.make({ userId }), { key: "reminder", after: "24 hours" })
yield * turn.cancelEffect("reminder")
```

**Q2. Delayed effects (`after`, `at`).** Default: include them. Without a delay the cancellable window is only until the next relay pass, and reminder-style work would still need a timer intent whose handler performs the effect.

**Q3. Outcome of a cancelled effect with no `onCancelled`.** Default: `Succeeded` routes to `onSuccess`, `Unknown` dead-letters as ambiguous, `Failed` is deleted and logged (section 3). Alternative: require `onCancelled` on every keyed effect type at compile time, which is stricter but forces a handler on effects like analytics pings that never need one.

**Q4. Cancel latency across runners.** Default: the renewal check, `executors.cancelCheck = lease / 3`, with a local wake on the same runner and no cross-runner message.

**Q5. Cap scope.** Default: per effect tag. Alternative: a named group shared by several tags (`concurrency: { perActor: 2, group: "provider-x" }`), which could be added later without breaking the per-tag form.

**Q6. Deployment-wide limits.** Default: out of scope (section 5); per-runner `executors.concurrency` plus an executor-side rate limiter until a later ADR designs a sharded quota.

**Q7. Cap enforcement primitive.** Default: a transaction-scoped advisory lock per capped actor and tag, with the durable running rows as the authority. Alternative: claim capped rows only for actors whose shard the runner owns, which avoids advisory locks but reintroduces bucket ownership that ADR 0021 removed.

**Q8. Does a cancelled attempt free its cap slot at cancellation or at settle?** Default: at settle, because its provider call may still be in flight.
