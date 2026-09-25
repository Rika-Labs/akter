# ADR 0021: Multi-runner relay, effect executors, singletons, and cron

**Status:** accepted (2026-09-26; proposed 2026-09-25). It amends [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) and [ADR 0011](0011-direct-commands-outbox-and-performance.md) where they say a runner scans only the buckets it owns, and it decides how [ADR 0010](0010-one-way-effect-native-api.md)'s `policy.cron` and `cronSkipIfOlderThan` work. The contract, architecture, API, and verification amendments listed under [Amendments](#amendments) land in the same change.

**Responsibility:** decide how the outbox relay, effect executors, singleton cron, and per-actor cron behave when several runners share one database, so that M2.4 (relay) and M2.5 (cron) have no open design questions.

**Authority:** design decision record.

**Owner role:** runtime and reliability architecture.

**Change policy:** supersede through a new ADR.

## Context

M1 shipped the outbox relay (#34, M1.6) and effects (#36, M1.7) on one embedded runner. That runner owns all 256 buckets, runs one relay pass at a time under a local semaphore, and settles at most 16 rows of a pass concurrently. The relay code is [`runtime/turn/relay.ts`](../../packages/durable-actors/src/runtime/turn/relay.ts).

Four things in that design stop it from working, or working well, with several runners:

1. **Nothing claims a row.** The relay's scan is a plain `SELECT`. Two runners would both deliver every due row. Receiver receipts make that safe for intents, but it doubles the work. Effect rows are safer, because each attempt claim is a compare-and-set on `attempts`.
2. **Executors run inside the relay pass.** An effect attempt holds one of the pass's 16 slots for up to its 30-second timeout, so a slow provider delays intent and timer delivery on that runner. #36 rejected moving executors out as an M2 redesign, and the API docs state the limit.
3. **Rows that die unsettled are rescanned first.** When a settle dies (the relay crashes after the receiver commits, or the delete fails), the row keeps its old `due_at_ms` and sorts ahead of newer rows. 256 or more such rows hold back all newer due work. #34 deferred this because the fix changes the tested crash semantics.
4. **The M1.7 timings are constants.** The executor timeout (30 s), the attempt lease (60 s), the attempt backoff (`min(2^(attempt - 1), 256)` s), and the no-executor retry (5 s) can't be configured.

Cron is not built. [Contract 08](../contracts/08-background-work.md) says `policy.cron` is per actor on named and minted actors and once per deployment on a singleton. [Contract 09](../contracts/09-recovery.md) says singleton cron responsibility moves to one surviving runner. Effect's `ClusterCron` can't be used: it stores each run as a persisted Cluster message, and the runtime uses `MessageStorage.layerNoop` because commands are direct ([ADR 0011](0011-direct-commands-outbox-and-performance.md)).

Dallen has approved `SELECT … FOR UPDATE SKIP LOCKED` claims on every runner as the claim mechanism.

### Measured starting point

All numbers come from the committed result files. One 4-vCPU AMD EPYC VM ran the client, the runtime, and Postgres 18.6 ([ADR 0018](0018-benchmark-harness-and-results.md)):

| Case (Postgres)                        | Throughput | p50      | p99      | Statements per op | File                                                                                             |
| -------------------------------------- | ---------- | -------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `outbox/delivery-sequential`           | 145.3/s    | 6.29 ms  | 17.88 ms | 22.13             | [`7806184-outbox`](../../benchmarks/results/2026-09-25-7806184-outbox-postgres.json)             |
| `outbox/delivery-concurrent-16`        | 284.5/s    | 54.95 ms | 94.71 ms | 20.25             | same                                                                                             |
| `outbox/drain-20000`                   | 661.4/s    | –        | –        | 8.02              | same                                                                                             |
| `outbox/delivery-beside-100000-timers` | 152.3/s    | 6.01 ms  | 16.85 ms | 22.13             | same; relay scan mean 0.294 ms (0.207 ms beside 10,000)                                          |
| `effect-round-trip/sequential`         | 106.0/s    | 9.31 ms  | 14.88 ms | 29.01             | [`5c06070-m1.7-effects`](../../benchmarks/results/2026-09-25-5c06070-m1.7-effects-postgres.json) |
| `effect-round-trip/concurrent-64`      | 225.4/s    | 276.8 ms | 420.3 ms | 25.07             | same                                                                                             |

The scan cost barely changes between 10,000 and 100,000 sleeping timers, which is the due-work property from ADR 0006. With 64 concurrent callers, the effect round trip is capped by the relay: 64 performed effects queue behind 16 settle slots, one pass at a time.

## Decision

### 1. Claims: every runner claims due rows with `FOR UPDATE SKIP LOCKED` and a lease

There is no bucket ownership. Every runner's relay scans all 256 buckets. It claims due rows in autocommit statements, only as many as it can start at once (its free intent-delivery slots or executor permits), and the claim moves each row's `due_at_ms` to the end of a lease. A claimed row therefore starts delivery immediately and never waits in a local queue while its lease runs down. A claimed row is no longer due, so other runners' scans skip it after the claim commits, and `SKIP LOCKED` skips it while the claim is in progress. No transaction stays open while the relay delivers, and no row lock outlives the claim statement.

Intent claim (`$limit` is the free delivery slots, at most `relay.passLimit`):

```sql
WITH candidates AS (           -- the M1 scan: one (bucket, due_at_ms) probe per bucket, no locks
  SELECT o.routing_key, o.intent_id
  FROM generate_series(-128, 127) AS b(bucket)
  CROSS JOIN LATERAL (
    SELECT routing_key, intent_id, due_at_ms FROM actor_outbox
    WHERE bucket = b.bucket AND kind = 'intent' AND due_at_ms <= $now
    ORDER BY due_at_ms LIMIT $candidates
  ) o
  ORDER BY o.due_at_ms LIMIT $candidates
),
claimed AS (                   -- lock only rows this pass will take; another runner's rows are skipped
  SELECT o.routing_key, o.intent_id FROM actor_outbox o
  JOIN candidates USING (routing_key, intent_id)
  WHERE o.kind = 'intent' AND o.due_at_ms <= $now  -- rechecked on the newest row version after the lock
  ORDER BY o.due_at_ms LIMIT $limit
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE actor_outbox o
SET attempts = o.attempts + 1,
    due_at_ms = $now + greatest($claimLease, least(1000 * power(2, least(o.attempts, 20)), $maxBackoff))::bigint
FROM claimed c
WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
RETURNING o.*, (SELECT count(*) FROM candidates) AS candidate_count
```

- **Index use.** The candidate scan is M1's per-bucket probe, on the index `actor_outbox_due_kind (bucket, kind, due_at_ms)` that `0011_relay` creates in place of `(bucket, due_at_ms)`, so intent scans never read effect rows and effect scans never read intents. Scan cost still follows due rows of the scanned kind, not stored actors. Only up to `$limit` rows are locked, and each is updated once. The `$candidates` oversample (default `2 × $limit`) keeps a runner that loses a race for the earliest rows from ending its claim empty. The relay claims again as soon as a slot frees while `candidate_count` came back equal to `$candidates`; otherwise it waits for a wake or the poll.
- **Settling.** A delivered intent is deleted after the receiver's receipt commits, as in M1. A failed delivery (receiver defect, `ActorUnavailable`, timeout) sets `due_at_ms = now + backoff(attempts)`. A crash, or a settle that dies, leaves the claim in place until the lease ends. Every settling write names the row and the lease it holds (`due_at_ms = $claimedUntil` for intents, `attempts = $n` for effects), so a runner whose lease has already passed to another runner changes nothing.
- **`attempts` counts claims.** It is written before the delivery starts, the same rule effects already follow. A receiver defect still leaves `attempts = 1` after the first delivery, as the M1.6 case `keeps an intent whose receiver defects and retries it with backoff` expects. **Behaviour change (API docs, operators):** `attempts` now also counts claims whose lease expired and rows released at shutdown, so the operator signal the API docs name, and M4.3's `attempts ≥ 8` gauge, count claims rather than failed deliveries.
- **Claim lease.** The default is the largest `commandTimeout + lockWait` among the actor types registered on the runner, plus 5 seconds (37 s with default policies). That bounds the receiver's turn transaction; `deliveryTimeout` does not, because it only stops the caller waiting and the admitted turn may commit later. Runners that register different actor types may compute different leases. Neither case is unsafe: a lease that ends mid-delivery costs one duplicate delivery, which the receipt deduplicates, and the late runner's settle then changes nothing.
- **Pipelining cost.** Claiming per free slot instead of per 256-row pass adds about one claim statement per 16 delivered rows under a backlog (+0.06 statements per row against `drain-20000`'s 8.02), and none for a lone intent, which M1 also scanned for.
- **Order.** Intents have no delivery order today, and they still have none.
- **Neki.** One claim statement covers every bucket on Postgres and PGlite. On Neki the relay sends one claim per bucket range that maps to one shard, so each statement stays single-shard under `__neki.fanout = 'single'` ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)). M5.1 verifies this. M1's scan has the same requirement.

**Migration `0011_relay` is used**, for one column and one index:

```sql
ALTER TABLE actor_outbox ADD COLUMN scheduled_at_ms bigint;  -- null on rows written before 0011
CREATE INDEX actor_outbox_due_kind ON actor_outbox (bucket, kind, due_at_ms);
DROP INDEX actor_outbox_due;
```

Claims and backoff overwrite `due_at_ms`. `scheduled_at_ms` keeps the time the row first became due: an intent's due time, a timer's `Intent.after`/`Intent.at` time, or a cron tick's scheduled time. Relay lag (`now − coalesce(scheduled_at_ms, due_at_ms)`, required by [performance](../verification/03-performance.md)) and the cron skip window ([section 5](#5-cron-keyed-self-timers-rewritten-by-the-relay)) read it. It isn't indexed, and claims don't write it. The index puts `kind` after `bucket` so effect rows that wait for an executor or for pool permits never sit in the intent scan's range, and the reverse.

**Behaviour change (ADR 0006, ADR 0011, contract 03, dispatch and storage-layout docs).** A runner no longer scans "only the buckets it owns". Every runner's relay may deliver any due row.

**Behaviour change (contract 09, failure matrix, `ActorTest`).** A relay that dies after claiming a row now delays that row's redelivery until the claim lease ends. In M1 the next pass redelivered it. `ActorTest.advance(claimLease)` makes the row due again, and `drain` no longer redelivers a row whose settle died in the same test until the clock moves past its lease. `drain` (and so `advance`) waits for in-flight intent deliveries and executor attempts before it checks for due rows, and returns when nothing is due and nothing is in flight. It still dies with `Outbox did not settle` after 100 rounds that each found due work; failing rows back off out of the due range, so they end a drain rather than loop it.

### 2. Executors run outside the relay pass, on a per-runner pool

Each runner has one effect executor pool with a concurrency limit (`executors.concurrency`, default 64). The relay pass claims effect rows only up to the pool's free permits and hands each claimed row to the pool. The pass doesn't wait for executors. Intent delivery keeps its own `relay.deliveryConcurrency` (default 16, M1's value), so a slow executor can't delay intents or timers.

An effect claim is the M1.7 attempt claim, taken in a batch with `SKIP LOCKED` and limited to free pool permits. The runner passes the effects it has executors for, with each one's attempt limit (`retry.times + 1`), so the claim filters on them and reads the limit per row:

```sql
WITH mine(actor_type, command, max_attempts) AS (VALUES ($1, $2, $3), ...),   -- this runner's executors
candidates AS (
  SELECT o.routing_key, o.intent_id
  FROM generate_series(-128, 127) AS b(bucket)
  CROSS JOIN LATERAL (
    SELECT routing_key, intent_id, due_at_ms, actor_type, command FROM actor_outbox
    WHERE bucket = b.bucket AND kind = 'effect' AND due_at_ms <= $now
    ORDER BY due_at_ms LIMIT $candidates
  ) o
  JOIN mine USING (actor_type, command)
  ORDER BY o.due_at_ms LIMIT $candidates
),
claimed AS (
  SELECT o.routing_key, o.intent_id, m.max_attempts FROM actor_outbox o
  JOIN candidates USING (routing_key, intent_id)
  JOIN mine m USING (actor_type, command)
  WHERE o.kind = 'effect' AND o.due_at_ms <= $now   -- a row a stale success just turned into an intent drops out
  ORDER BY o.due_at_ms LIMIT $permits
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE actor_outbox o SET
  due_at_ms  = $now + $lease,
  -- An exhausted row is only fenced: the relay dead-letters it with the outcome already recorded.
  attempts   = CASE WHEN o.attempts < c.max_attempts THEN o.attempts + 1 ELSE o.attempts END,
  ambiguous  = CASE WHEN o.attempts < c.max_attempts THEN true ELSE o.ambiguous END,
  last_error = CASE WHEN o.attempts < c.max_attempts
                    THEN 'Attempt ' || (o.attempts + 1) || ' ended without reporting an outcome'
                    ELSE o.last_error END
FROM claimed c
WHERE o.routing_key = c.routing_key AND o.intent_id = c.intent_id
RETURNING o.*, o.attempts >= c.max_attempts AS exhausted
```

A row that was already exhausted when claimed (its last attempt crashed, or its dead-letter transaction failed after the last attempt's typed failure) keeps its `attempts`, `ambiguous`, and `last_error`, exactly as M1.7's `row.attempts >= registered.attempts` branch does, so its dead letter reports the recorded attempt count and classification. A row with no executor on a runner is never claimed there and stays due, in the effect range of the index only, until a runner that has one claims it.

Leases and expiry:

- **Renewal.** While an attempt runs, the pool renews its lease every `lease / 3` with `UPDATE actor_outbox SET due_at_ms = $now + $lease WHERE routing_key = $rk AND intent_id = $id AND kind = 'effect' AND attempts = $n`. A long provider call keeps its claim for as long as the runner stays healthy. When the executor returns, the pool stops the renewal fiber and awaits it before any settling write, so a late renewal can't overwrite a failure's backoff with a fresh lease.
- **Lost lease.** If a renewal matches no row, the attempt has lost its claim. The pool interrupts the executor fiber and logs `Effect attempt lost its lease`. If renewals keep failing (for example because the database is unreachable) until the lease's deadline passes, the pool interrupts the attempt at that deadline. The deadline is a monotonic duration of `lease` measured from when the last successful claim or renewal statement was sent, not a wall-clock comparison with `due_at_ms`, so runner–database clock skew doesn't matter: the database's lease can only end later than the runner's.
- **Takeover.** Once the lease has passed, any runner with the executor claims attempt `n + 1`. The row still says `ambiguous = true` from attempt `n`'s claim. If `n` used the last attempt, the takeover dead-letters it with `ambiguous: true`, as M1.7 does for a crashed attempt.
- **Stale results.** A success settles with a guard on `kind = 'effect'` alone, not on the attempt: the first success of any attempt wins and turns the row into its route, and at most one result is routed because the row stops being an effect. A stale success therefore still counts when it beats the takeover's outcome. A success that arrives after the row was dead-lettered matches no row; the pool then sets `ambiguous = true` on the effect's `actor_dead_letters` row and logs `Effect succeeded after it was dead-lettered`, because the provider applied the call after the dead letter had been routed. A failure or unknown outcome from attempt `n` keeps the `attempts = n` guard, so a stale failure never overwrites a newer attempt's record. Executors keep using `effectId` as the provider's idempotency key.

P1 holds. The dead letter is `ambiguous: false` only when the last attempt ended in a typed failure and no success arrived, and at most one result is routed per effect id, because routing is a compare-and-set on the row still being an effect.

**Behaviour change (contract 08, API docs).** A dead letter's stored `ambiguous` flag can turn from `false` to `true` after `onDeadLetter` was routed, when a lease-expired attempt's success arrives late. The routed `Actor.DeadLetter` input is not changed.

**Behaviour change (contract 08, API docs).** Two attempts of one effect can now overlap. That happens only after a lease expires while the first attempt is still calling the provider: its runner lost the database, or its local deadline passed before a takeover's claim committed. In M1, with one relay and a 60 s lease over a 30 s timeout, attempts effectively ran one after another. Contract 08 now says so, and it requires executors to be idempotent under `effectId`, which the API docs already recommend.

**Behaviour change (API docs).** A runner without an executor for an effect no longer claims the row. The 5-second "no executor registered" retry and its warning are removed. Rows wait for a runner that has the executor, and the effect's relay lag shows the wait. That lag gets its operator signal in M4.3.

**Behaviour change (API docs).** A slow executor no longer delays intent and timer delivery on its runner. The API note that says it does is removed.

On graceful shutdown the relay stops claiming. It sets `due_at_ms = now` on intent rows it claimed but hasn't started, and waits up to the drain deadline for running attempts, then interrupts them. Interrupted attempts keep `ambiguous = true` and are taken over after their lease, which is the "drain deadline expires" row of the failure matrix.

### 3. Effect timings become configurable

Per-effect timings live in `policy.effects[Tag]`, next to `retry` and the routes. Runner mechanics live in `Actors.layer`. Every default equals the M1.7 constant, so no deployment's behaviour changes unless it sets them.

```ts
export const Moderation = Actor.make("Moderation", {
  key: PostId,
  effects: [Moderate],
  api: { Moderated, ModerationFailed },
  policy: {
    effects: {
      Moderate: {
        timeout: "30 seconds", // default; one attempt, measured on the runner
        retry: { times: 3, backoff: { base: "1 second", max: "256 seconds" } }, // defaults
        onSuccess: Moderated,
        onDeadLetter: ModerationFailed,
      },
    },
  },
})

const runtime = Actors.layer({
  authorize,
  relay: {
    poll: "1 second", // default; durable polling interval, with ±10% jitter per runner
    passLimit: 256, // default; intent rows claimed per pass
    deliveryConcurrency: 16, // default; intents delivered at once per runner
    claimLease: "37 seconds", // default: largest commandTimeout + lockWait + 5 s
    maxBackoff: "256 seconds", // default; cap for intent redelivery backoff
  },
  executors: {
    concurrency: 64, // default; effect attempts running at once per runner
    lease: "60 seconds", // default; renewed every lease / 3 while an attempt runs
  },
})
```

- `timeout` is a `Duration.Input` from 1 ms to 2^31 − 1 ms. `retry.backoff.base` and `retry.backoff.max` are durations in the same range, with `max ≥ base`. Attempt `n` fails into a wait of `min(base × 2^(n − 1), max)`. `Actor.make` rejects a value out of range, and the types reject unknown keys, as they already do for `retry.times`.
- `executors.lease` doesn't have to exceed any `timeout`, because renewal keeps a long attempt's claim. A lease under 3 seconds is rejected at startup, so renewals are at least a second apart.
- The per-effect settings are read when a row is claimed, by the claiming runner, so a deployment that changes them also affects rows that are already pending. During a rolling deploy ([versioning](../api/versioning.md)) old and new runners may each apply their own settings to different attempts of one effect. That is safe: every setting only changes timing, never whether an attempt is recorded or which result routes.
- The 5-second no-executor retry has no setting, because [section 2](#2-executors-run-outside-the-relay-pass-on-a-per-runner-pool) removes it.

### 4. Relay defect policy: dead rows back off with a cap

A row whose settle dies keeps its claim, so it isn't due again until `max(claimLease, backoff(attempts))` has passed, where `backoff(n) = min(1 s × 2^(n − 1), relay.maxBackoff)`. This is M1's delivery-failure backoff, which is kept. A row that kills its settle every time is therefore tried at most once per `maxBackoff` (256 s by default), and never sorts ahead of newer due rows while it waits. Any number of dead rows can no longer hold back newer work.

Intents still have no retry limit and no dead letter. A committed intent is accepted work that contract 05 requires to be delivered. `attempts` and the warning `Outbox delivery failed; retrying with backoff` stay the operator signal. M4.3 adds a gauge of rows with `attempts ≥ 8`.

**Behaviour change (failure matrix).** The M1 loop guard ("a pass whose rows died waits for the poll") still applies, but it no longer matters for correctness. Dead rows aren't due, so the next pass can't pick them again.

### 5. Cron: keyed self-timers rewritten by the relay

Cron is an outbox timer, not a runner responsibility. Expressions are parsed with Effect's `Cron.parse` (five fields, or six with seconds); `Actor.make` rejects one that doesn't parse, and two entries whose parsed schedules are equal. The key is the expression's canonical form (fields joined by single spaces), so whitespace variants are one entry. For each `policy.cron` entry an actor has at most one pending tick row: the actor's own outbox row with `timer_key = '$cron:' || canonical expression`, targeting its cron command, due at the next scheduled time. The existing unique index on `(routing_key, tenant_id, actor_type, actor_id, timer_key)` enforces one pending tick per entry. A tick is delivered as a direct command with the caller `System({ source: "cron", ref: <actor> })`, with no `onBehalfOf`, like any timer, so it activates the actor wherever it lives. No runner has to be resident for cron to run.

**Writing the first tick.**

- _Named and minted actors._ The first turn a generation commits also writes any missing tick rows, with `INSERT … ON CONFLICT DO NOTHING` in its commit statement, so it adds no round trip. A declared failure commits too, so it writes them as well. A turn that commits nothing, such as a `NotCreated` rejection under `createdBy`, writes none. This covers the creating turn, and it lets a cron entry added by a later deploy reach existing actors on their next activation.
- _Singletons._ At startup each runner writes the missing tick rows for every singleton type with `policy.cron`, in the deployment's default tenant (`"default"`; `ActorTest.layer` uses its own fresh tenant here, so tests observe singleton ticks through `test.actor`). It first creates the singleton's generation row if the row doesn't exist, without marking the actor created. The insert is idempotent, so runners that race at startup still leave one row per entry. Singleton instances in other tenants get no cron (see [open question 4](#open-questions-and-recommended-defaults)).

**Delivering and rewriting a tick.** A runner claims `$cron:` rows only for actor types registered on it (a filter on the intent claim, like the executor filter on effects), so a runner that doesn't host the type, or whose layers haven't registered yet, never touches them. Then:

1. If the actor type's `policy.cron` on this runner has no entry for this expression, the relay doesn't deliver the tick. It deletes the row only if the tick is also older than `cronSkipIfOlderThan`; otherwise it releases it with backoff. During a rolling deploy an old runner therefore leaves a new entry's tick for a new runner, and a removed entry's row is gone within one skip window after the deploy. A changed expression is a removal plus an addition, and a changed target command is picked up at the next rewrite, which always uses the claiming runner's current entry.
2. If `now − scheduled_at_ms > cronSkipIfOlderThan`, the relay skips the handler and logs `Cron tick skipped`.
3. Otherwise it delivers the tick command, and the tick's receipt commits.
4. In both cases, one statement rewrites the row in place to the next tick: a new intent id, `scheduled_at_ms` and `due_at_ms` set to the first scheduled time after `now`, and `attempts = 0`. The rewrite names the claim it holds, as every settling write does.

```ts
export const Digest = Actor.make("Digest", {
  key: Actor.singleton,
  api: { Send },
  // One tick a day at 08:00 UTC across the deployment; a tick more than an hour late is skipped.
  policy: { cron: { "0 8 * * *": Send }, cronSkipIfOlderThan: "1 hour" },
})
```

Rules this gives:

- **One logical tick.** A tick's command id is its row's intent id, so a redelivery after a crash replays the receipt. The row is rewritten only after the receipt commits. A crash between the commit and the rewrite redelivers the same id, which replays, and then rewrites once. Two runners can't both hold the claim.
- **A claimed tick fires once**, consistent with contract 05's timer-cancel rule. A deploy that removes the entry doesn't stop a delivery that has already started; the row is deleted later under rule 1. Handlers that must ignore a superseded tick check state.
- **Catch-up after downtime.** When the deployment comes back, each pending tick is at most one row. If it is inside the skip window it fires once, otherwise it is skipped. Either way the next tick is the first scheduled time after now, so missed ticks are never replayed one by one.
- **Failures.** A declared failure commits a receipt, so the tick is done and the row is rewritten. A deterministic defect or unavailable receiver leaves the row with backoff, and each later claim rechecks the skip window. A tick that keeps failing until it falls out of the window is then skipped.
- **Overlap.** Ticks of one entry never overlap, because the next row exists only after the previous tick's receipt commits. A handler slower than its interval skips the ticks it overran.
- **Clock and zone.** Scheduled times come from the database clock, like every outbox time, and expressions are evaluated in UTC.
- **`cronSkipIfOlderThan`** is one actor-level duration, as ADR 0010 and the M2 plan declare it. The default is 1 day, which matches `ClusterCron`'s `skipIfOlderThan`.
- **Reserved keys.** `Intent.key` values that start with `$cron:` are reserved. Staging or cancelling one dies with `Intent key "$cron:…" is reserved for cron`.

- **Stopping.** Per-actor cron runs for as long as the actor's type declares it; an application can't stop one actor's schedule, and the framework has no actor deletion yet. An actor that should go quiet checks its state in the tick handler and returns. Cron rows therefore grow with the number of actors of a cron type ever activated, one row per entry, and cost scans only when due. This is an accepted cost; revisit when actor deletion or archival exists, which must delete the actor's `$cron:` rows in its transaction.

**Cron needs no migration** (the reservation `0012_cron` is dropped). Cron needs only the reserved key, the existing unique index, and `0011_relay`'s `scheduled_at_ms`.

**Behaviour change (contract 09, dispatch docs).** Cron is no longer a responsibility a runner holds and hands over. The tick is an outbox row that any surviving runner's relay claims. Its delivery is a command to the singleton, so it runs once the singleton is resident again, through ordinary singleton failover. Residency and the `Effect.forkScoped` loop still move to exactly one survivor.

**Behaviour change (contract 08).** "Once per deployment" for singleton cron means once in the default tenant.

**Behaviour change (API docs).** `Intent.key` has a reserved prefix.

### 6. Wake-ups after commit stay local; polling is the correctness path

Any runner may claim any row, so the runner that committed a turn is always a valid relay for the rows that turn wrote. A commit that writes an already-due row wakes only its own runner's relay, as in M1. The same goes for effect settlements that turn into `onSuccess` or `onDeadLetter` intents. No runner-to-runner wake message is sent, because it would add one Cluster message per commit and deliver nothing sooner. `LISTEN/NOTIFY` stays prohibited ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)).

Every runner polls every `relay.poll` (1 s) with ±10% jitter, which is the correctness path. Rows written by a runner that dies before its relay runs are picked up by any survivor within one poll. Delayed timers become due without a wake and are found by polling, so a timer's delivery lags its due time by up to one poll interval. That matches M1.

Runner-to-runner wakes through Cluster routing remain permitted by ADR 0006, for a case where measurements show that polling lag matters, such as a runner saturated by its own relay while peers are idle. This ADR doesn't build them.

### 7. Singletons

Singleton residency and the background loop use Cluster's `registerSingleton`, as M1 already does. M2.2 proves one activation and one loop across runners. The relay isn't a singleton. Cron doesn't depend on singleton residency ([section 5](#5-cron-keyed-self-timers-rewritten-by-the-relay)). Singletons run only in the primary region ([ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md)), and their tick rows live on their own shard like any actor's.

## Open questions and recommended defaults

Each has a recommended default that this ADR adopts.

**Resolution (2026-09-26).** Dallen accepted the ADR with every default below. He explicitly confirmed question 8: no runner-to-runner wakes. He delegated question 4 to the M2 planning lead, who kept the default: singleton cron runs in the default tenant only, and per-tenant jobs use a named actor.

1. **Claim lease for intents.** Recommended: derived as the largest `commandTimeout + lockWait` + 5 s, and overridable with `relay.claimLease`. The alternative, a fixed 10 s, recovers faster after a relay crash, but a slow receiver would get duplicate deliveries.

   ```ts
   Actors.layer({ authorize, relay: { claimLease: "10 seconds" } }) // opt in to faster crash recovery
   ```

2. **Executor pool size.** Recommended: `executors.concurrency: 64` per runner. Executors have no database capability, so a running attempt holds no Postgres connection. Only claims, renewals, and settles use one, briefly, from the runner's shared pool (50 by default, [ADR 0019](0019-runner-capacity-and-pool-size.md)). 64 attempts renewing a 60 s lease add about 3 statements a second.
3. **Effects with no executor on a runner.** Recommended: that runner doesn't claim them. The rows wait for a runner that has the executor, and the 5 s retry goes away. Alternative: keep M1's claim-and-release every 5 s, which costs a claim per row per runner that lacks the executor.
4. **Which tenant runs singleton cron.** Recommended: the deployment's default tenant, bootstrapped at startup, which matches contract 08's "once per deployment". Alternative: every tenant's singleton instance runs its own cron from its first activation. That needs a tenant registry to start cron in tenants whose singleton was never called.

   ```ts
   // Recommended: runs once per deployment, in tenant "default", even if nothing ever calls it.
   const Janitor = Actor.make("Janitor", {
     key: Actor.singleton,
     api: { Sweep },
     policy: { cron: { "*/5 * * * *": Sweep } },
   })
   // A per-tenant schedule is a named actor, e.g. TenantJanitor.get("main") in each tenant;
   // its first turn in that tenant writes the tick.
   const TenantJanitor = Actor.make("TenantJanitor", {
     key: Schema.Literal("main"),
     api: { Sweep },
     policy: { cron: { "*/5 * * * *": Sweep } },
   })
   ```

5. **Cron added to an actor type that already has actors.** Recommended: existing actors get the new tick on their next activation. An actor that never wakes again never ticks. Alternative: a startup backfill across every actor of the type, which is a scan proportional to stored actors that ADR 0006 forbids on the hot path. If needed it belongs to M4 operations tooling.
6. **`cronSkipIfOlderThan` default and scope.** Recommended: 1 day, one value per actor type. A per-expression option (`cron: { "0 8 * * *": { command: Send, skipIfOlderThan: "1 hour" } }`) can be added later without breaking the actor-level form.
7. **Bucket affinity.** Recommended: none now. Every runner scans all 256 buckets each poll, which is 256 index probes per runner per second at about 0.3 ms per scan in the measured run. Revisit when runner count or scan time makes idle scanning visible, for example beyond 32 runners or when the scan exceeds 5% of a relay connection. The fallback is soft affinity: each runner scans a preferred bucket subset every pass and all buckets every fourth pass. Claims stay `SKIP LOCKED`, so affinity never becomes ownership.

8. **Runner-to-runner wakes.** The M2 plan listed "wake-up messages after commit" as runner-to-runner messages. Recommended: don't send them ([section 6](#6-wake-ups-after-commit-stay-local-polling-is-the-correctness-path)), because the committing runner can claim the rows itself. Alternative: after a commit, send a volatile Cluster message to a peer runner chosen by bucket, so a busy runner's due rows are picked up by an idle one.

   ```ts
   // Sketch, not built: a volatile Cluster entity per bucket, told after each commit that wrote a due row.
   Effect.gen(function* () {
     const wake = yield* RelayWake.client
     yield* wake(String(bucketOf(routingKey))).Wake(undefined, { discard: true })
   })
   ```

## Alternatives

- **Bucket ownership (each runner scans only the buckets it owns).** Rejected. Cluster routes with `shardsPerGroup: 1`, so Cluster shards don't map to buckets, and ownership would need a new bucket-lease table, a rebalancing protocol, and a takeover path. A dead runner's buckets would stall until the lease expired, even for rows it never touched. With `SKIP LOCKED`, only rows the dead runner had claimed wait, and only until their lease ends.
- **Hold the row lock for the whole delivery (claim and deliver in one transaction).** Rejected. It keeps a transaction open across a network call to another runner. The sender's own `Intent.cancel` or key replacement would block on the lock and fail on its 2 s `lock_timeout`. It also holds a pool connection per in-flight row.
- **A separate `leased_until_ms` column.** Rejected. Scans would need a second predicate that `actor_outbox_due` can't serve, so leased rows would be read on every probe.
- **Next cron tick written by the tick's turn.** Rejected. A declared failure rolls back staged intents, so the next tick would need a special staging path that survives rollback. A defect would stop the schedule until an unrelated turn wrote it again. Rewriting in the relay's settle statement is the same pattern as an effect row turning into its route.
- **`ClusterCron` for singleton cron.** Rejected. It needs persisted Cluster messages, which the runtime doesn't store, and it would be a second schedule path next to outbox timers.
- **A runner-to-runner wake per commit.** Rejected for now ([section 6](#6-wake-ups-after-commit-stay-local-polling-is-the-correctness-path)).
- **A retry limit and dead letter for intents.** Rejected. A committed intent is accepted work (contracts 05 and 08). Giving up on it would silently drop a receiver transition.

## Consequences

- Claim statements replace M1's scan, one per batch of free slots, so statements per delivered intent should stay within 0.5 of M1's level. Each delivered row now gets one extra heap and index version, from the claim's update to `due_at_ms`, before its delete. The outbox benchmark must show it.
- Crash recovery for a claimed row takes up to one claim lease instead of one pass. Runner-kill recovery already waits `shardLockExpiration` for the dead runner's actors, so the lease is of the same order.
- Effects scale with `executors.concurrency × runners`, not 16 per pass per process.
- An executor must tolerate overlapping attempts under one `effectId` after a lease expiry. The API docs already require provider idempotency on `effectId`.
- Cron costs one outbox row per actor per cron entry, and scanning ticks costs what is due, like any timer.

## Amendments

In this change:

- [Contract 03](../contracts/03-transactions.md): any runner's relay delivers a committed row after claiming it with a lease, instead of the owning runner's relay.
- [Contract 05](../contracts/05-messaging.md): relay claims, leases, redelivery after lease expiry, reserved `$cron:` keys, and cron ticks as keyed timers.
- [Contract 08](../contracts/08-background-work.md): the executor pool, leases, renewal and overlapping attempts, configurable timings, and cron semantics, including the singleton default tenant.
- [Contract 09](../contracts/09-recovery.md): cron has no runner responsibility, and outbox recovery waits for the claim lease.
- [Dispatch](../architecture/04-dispatch.md) and [storage layout](../architecture/03-storage-layout.md): claims, `scheduled_at_ms`, local wakes, and cron rows.
- [Server API](../api/01-server-api.md): the policy and runtime settings above, and the reserved key (target API).
- [Conformance](../verification/01-conformance.md): the **Relay claims** and **Cron** checks. [Failure matrix](../verification/02-failure-matrix.md): amended relay rows and new rows.

## Required evidence

### M2.4 (multi-runner relay, `conformance/relay.ts`, migration `0011_relay`)

Cases on the M2.1 harness against real Postgres, with at least two runners unless stated:

- `claims each due row on exactly one runner` — two to four runners poll one backlog. Every intent id has one receiver receipt, and no row is claimed by two runners within one lease (`attempts` stays 1).
- `redelivers a row after its claim lease when the claiming runner is killed` — kill at `beforeDelivery`. No survivor delivers before the lease ends, and one delivers the same intent id after it.
- `redelivers after a runner kill between receiver commit and row deletion with one receiver transition` — kill at `beforeOutboxDelete`. The receipt replays on a survivor, and the row is deleted.
- `does not let rows that die unsettled delay newer due rows` — 300 rows whose settle dies, then one fresh intent. The fresh intent is delivered within one poll, and the dead rows' next claims follow `max(claimLease, backoff(attempts))` up to `maxBackoff`.
- `keeps a stale runner's settle from changing a row another runner claimed` — pause runner A after its claim, let the lease pass, and let runner B deliver. A's delete or reschedule changes nothing.
- `delivers intents while every executor slot runs a slow effect` — executors block for 10 s. Intent delivery p99 stays within the no-effect baseline plus one poll.
- `renews an executor lease so a long attempt is not taken over` — the executor runs for 3 × the lease. Attempt 1 routes, and no attempt 2 starts.
- `interrupts an attempt that loses its lease and routes at most one result` — block runner A's renewals. B takes over as attempt 2 with `ambiguous = true`. A's late success routes nothing, and B's result routes once.
- `dead-letters as ambiguous when the last attempt's lease expires` — `retry: { times: 0 }` and the runner is killed mid-call. The dead letter has `ambiguous: true`, and `onDeadLetter` commits once.
- `claims effects only on runners that have their executor` — runner A has no effect layer. A never claims the row, and B runs it once.
- `uses per-effect timeout and backoff from policy.effects` — a 100 ms timeout and a `{ base: "10 millis", max: "40 millis" }` backoff show up in the attempt timings and in `due_at_ms`.
- `claims no more intents than free delivery slots` — receivers that take 20 s and a 300-row backlog on one runner: no claimed row waits locally, and no row's lease expires before its delivery starts.
- `dead-letters an already exhausted row with its recorded outcome` — the dead-letter transaction fails after the last attempt's typed failure; the next claim fences without counting, and the dead letter has `attempts = retry.times + 1` and `ambiguous: false`.
- `routes a lease-expired attempt's success when it beats the takeover` and `marks the dead letter ambiguous when a stale success arrives after it` — attempt 1 loses its lease and later succeeds; attempt 2 is the last and fails typed.
- `interrupts an attempt at its local deadline when renewals cannot reach the database` — renewals fail; the executor is interrupted after `lease`, before another runner's claim.
- `keeps a failure's backoff when a renewal races the settle` — a renewal is paused until after the failure write; `due_at_ms` keeps the backoff.
- `releases claimed but unstarted rows on graceful shutdown`.
- **Due-work scans** check for the new claims: `EXPLAIN (ANALYZE, BUFFERS)` of the intent claim with 10,000 due effect rows that no runner has an executor for reads no effect rows, and the M1.6 sleeping-timer case keeps its bound.
- Fault points `afterClaim` (a relay or pool paused or crashed after its claim commits) and `beforeRenew` (a renewal blocked or failed) are added to `TurnHooks` and the `crashNext`/`pauseNext` list.
- Existing M1.6 and M1.7 cases keep their names and receiver-side assertions. Where a case relied on immediate redelivery after a crash, it advances the outbox clock by the claim lease first; `delivers a keyed timer once when it is cancelled after the relay picked it up` now finds the claimed row and deletes it, and the firing timer still arrives once.
- Shared PGlite and Postgres cases for the single-runner parts: lease backoff, `scheduled_at_ms` preserved across claims, and configuration validation.

Failure-matrix rows (added in this change): **Relay dies after claiming, before delivery**, **Relay settle dies on the same row repeatedly**, **Two runners claim the same due rows**, **Executor lease expires mid-call**, **Stale attempt reports after takeover**, **Runner without an executor sees a due effect**, **Executor renewals fail on a partitioned runner**, and **Claimed intents outlive their lease in a slow pass**. The existing rows **Relay crash after sender COMMIT**, **Relay crash after receiver commit / before outbox row deletion**, and **Provider success / result acknowledgment lost** are also run with a runner kill between the steps.

Benchmarks: `outbox` and `effect-round-trip` with `--runners 1,2,4`. On one runner, statements per delivered intent stay within 0.5 of the M1 run (22.13). `drain-20000` scales with runners. `effect-round-trip/concurrent-64` exceeds 225 ops/s on one runner, because it is no longer capped at 16 per pass. A new case, `effect-round-trip/slow-executor-beside-intents`, shows intent delivery p99 unchanged while executors block.

### M2.5 (cron, `conformance/cron.ts`, no migration)

- `writes one tick row per cron entry on the creating turn` — also when the creating turn's command fails with a declared error.
- `adds a new cron entry to an existing actor on its next activation`, and `removes a tick whose expression left the policy`.
- `produces one logical tick on two runners` — the cron half of **Singleton uniqueness**. Both runners bootstrap the singleton, and one receipt is committed per scheduled time.
- `fires once after downtime inside the skip window and skips outside it` — the deployment is stopped for 2 × the interval (fires once) and for longer than `cronSkipIfOlderThan` (skips). In both cases the next tick is the first scheduled time after restart.
- `rewrites the tick once after a crash between the tick's receipt and the rewrite` — kill at `beforeOutboxDelete` on the tick. There is one receipt and one next-tick row.
- `fires a claimed tick once after its entry is removed` — the contract 05 rule, for cron.
- `keeps ticks of one entry from overlapping` — a handler slower than its interval.
- `rejects a $cron: intent key` — staging and cancelling one both die.
- `never deletes ticks on a runner without the actor type` — runner A doesn't register the cron type; its relay never claims the tick, and B delivers it.
- `keeps a new entry's tick while an old runner lacks the entry` — a rolling deploy; the old runner releases the tick, and it's deleted only once older than the skip window.
- `rejects an unparsable cron expression and equal schedules at Actor.make`.
- **Singleton runner dies** with cron: kill the singleton's runner. The tick is delivered once after residency moves, and lock expiry and resumed service are recorded separately.
- The **API shape** check: a cron target with input, or a cron key naming an unknown command, fails to compile.

Failure-matrix rows (added in this change): **Cron tick crashes after its receipt, before the rewrite**, **Deployment down longer than `cronSkipIfOlderThan`**, and **Runners race to bootstrap singleton cron**, and **Runner without the actor type claims a cron tick**. The existing row **Singleton runner dies** is amended.

Benchmark: `cron`. Tick lateness (`deliver time − scheduled_at_ms`) at p50, p99, and max, with 10^5 actors declaring a per-minute cron over 1, 2, and 4 runners, plus relay scan time beside those rows.

## Revisit conditions

- Idle scanning becomes visible: more than 32 runners, or the claim scan above 5% of a relay connection ([open question 7](#open-questions-and-recommended-defaults)).
- Neki measurements show that per-shard claims cost more than the due work they find.
- A measured need for sub-poll timer latency, which would bring back runner-to-runner wakes.
- A request, from someone other than an agent product, for per-actor effect concurrency or cancellation. Both stay parked ([contract 08](../contracts/08-background-work.md)).
