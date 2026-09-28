# ADR 0042: Cron time zones, fixed intervals, and daylight saving

**Status:** accepted (2026-09-28, Dallen, with every recommended default below). It amends [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) section 5, where the tick key is `$cron:<canonical expression>` and expressions are evaluated in UTC. The contract and API amendments listed under [Amendments](#amendments) land in the same change. The implementation is M2.5's follow-up to [#132](https://github.com/Rika-Labs/durable-actors/pull/132).

**Responsibility:** decide how a `policy.cron` entry names a time zone or a fixed interval, what its tick key is, which instants a zoned schedule fires at across daylight-saving transitions, and how ADR 0021's catch-up rule applies to zones and intervals.

**Authority:** design decision record.

**Owner role:** runtime and reliability architecture.

**Change policy:** supersede through a new ADR.

## Context

[M2](../milestones/M2.md) M2.5 asks for schedules that take a time zone (an IANA name, default UTC) and for fixed intervals as well as cron expressions. It sets two rules for daylight saving: a wall-clock time that doesn't exist during a spring-forward transition fires at the first instant after the gap, and a time that repeats during fall-back fires once. It also says the tick key must include the zone, because one expression in two zones would otherwise share a key.

ADR 0021 (accepted) keys each entry's pending tick as `$cron:<canonical expression>`, evaluates expressions in UTC, and settles catch-up: at most one pending tick per entry, a claimed tick older than `cronSkipIfOlderThan` is skipped, and every rewrite moves the row to the first scheduled time after now. Nothing in it says what "scheduled time" means in a zone that has transitions, or for an interval.

Effect's `Cron.next` takes a zone, but it doesn't meet M2's gap rule. Measured with `effect` 4.0.0-rc.116 in `America/New_York`: `30 2 * * *` on 2027-03-14 returns 03:30 EDT (the skipped time moved forward by the gap's length), not 03:00 EDT, the first instant after the gap. Its fall-back behaviour already fires a repeated time once, at the first occurrence.

Runtimes also spell zones differently. `Intl.DateTimeFormat(…, { timeZone }).resolvedOptions().timeZone` returns `US/Eastern` for `US/Eastern` under Bun 1.4 and `America/New_York` under Node 26, and `UTC` for `Etc/UTC` under Node but `Etc/UTC` under Bun. A key built from the runtime's resolved name could differ between two runners in one deployment.

## Decision

### 1. Declaring a zone or an interval

`policy.cron` stays a record from schedule strings to zero-input commands, so the type check on targets (`CronTarget`) doesn't change. The key takes one of three forms:

```ts
policy: {
  cron: {
    "0 8 * * *": Digest, // cron expression, UTC (unchanged)
    "CRON_TZ=America/New_York 0 8 * * 1-5": OpenDesk, // cron expression in an IANA zone
    "CRON_TZ=Europe/London 0 8 * * 1-5": OpenLondonDesk, // the same expression in another zone is another entry
    "@every 90 minutes": Reconcile, // fixed interval
  },
}
```

- **Zoned expressions.** `CRON_TZ=<zone> <expression>` evaluates the expression in `<zone>`. The prefix is the one cronie and robfig/cron use for the same purpose. `<zone>` must be an IANA name the runtime's time-zone database knows (`America/New_York`, `Etc/GMT+5`, `UTC`); `Actor.make` rejects an unknown name and a fixed offset such as `+05:00`. Without the prefix the zone is `UTC`.
- **Intervals.** `@every <duration>` fires every `<duration>`, where `<duration>` is a `Duration.Input` string such as `90 minutes` or `1 day`. It must be a whole number of milliseconds and at least 1 second. `Actor.make` rejects a zone prefix on an interval, because an interval is elapsed time and has no wall clock.
- **Everything else is as before.** Expressions are parsed with `Cron.parse` (five or six fields), whitespace is normalized, and `Actor.make` rejects an unparsable expression, a target that isn't a zero-input command of the actor, and two entries with the same tick key.

### 2. The tick key includes the zone

The tick key is:

| Entry                                   | Tick key                                   |
| --------------------------------------- | ------------------------------------------ |
| `0 8 * * 1-5` (UTC)                     | `$cron:UTC 0 8 * * 1,2,3,4,5`              |
| `CRON_TZ=America/New_York 0  8 * * 1-5` | `$cron:America/New_York 0 8 * * 1,2,3,4,5` |
| `CRON_TZ=Europe/London 0 8 * * 1-5`     | `$cron:Europe/London 0 8 * * 1,2,3,4,5`    |
| `@every 90 minutes`                     | `$cron:@every 5400000ms`                   |

- The expression part is ADR 0021's canonical form (sorted value lists, `*` for a full field, seconds only when not `0`), so equivalent spellings in one zone are one key and `Actor.make` rejects them as duplicates.
- The zone part is the name as declared, not as the runtime resolves it, because runtimes resolve aliases differently ([Context](#context)). `CRON_TZ=UTC 0 8 * * *` and `0 8 * * *` are one key. Aliases such as `US/Eastern` and `America/New_York` are two keys, and two entries.
- An interval's key is its length in milliseconds, so `@every 90 minutes` and `@every 1.5 hours` are one key.
- The same expression in two zones gives two keys, two rows, and two independent schedules on one actor.

UTC entries change key from `$cron:<expression>` to `$cron:UTC <expression>`. No deployment runs ADR 0021's keys yet (M2.5 is unreleased), so no migration or rewrite of stored rows is needed. A row with a pre-0042 key is handled by ADR 0021's removed-entry rule: released inside the skip window, deleted after it.

Changing an entry's zone or interval changes its key, so a deploy that does it is a removal plus an addition, like changing the expression. During a rolling deploy an old runner releases the new key's tick for a new runner, as ADR 0021 already requires.

### 3. Scheduled times in a zone

A zoned expression's fields are read against the zone's wall clock. Instant _t_ is a scheduled time when either:

- the zone's wall clock at _t_ matches the expression, and _t_ is the earliest instant that shows that wall-clock time; or
- _t_ is the first instant after a gap (a spring-forward transition), and at least one wall-clock time inside the gap matches the expression.

The next tick is the first scheduled time strictly after the given instant. So:

- **Skipped times fire once, just after the gap.** In `America/New_York` on 2027-03-14, clocks go from 02:00 EST to 03:00 EDT. `30 2 * * *` fires at 03:00 EDT (07:00Z). `*/15 * * * *` fires at 01:45 EST and then once at 03:00 EDT, for the four skipped times and 03:00 itself together, then at 03:15 EDT.
- **Repeated times fire once, at their first occurrence.** On 2026-11-01, clocks go from 02:00 EDT back to 01:00 EST. `30 1 * * *` fires at 01:30 EDT (05:30Z) and not at 01:30 EST (06:30Z). `0 * * * *` fires at 01:00 EDT and next at 02:00 EST, two hours later, because 01:00 EST repeats a time that already fired.
- **The rule depends only on the instant.** The second occurrence of a repeated time is never a scheduled time, whether the rewrite runs just after the first occurrence, inside the repeated hour, or after downtime. So no crash, slow handler, or late rewrite can make a repeated time fire twice.
- **Zones without transitions** give the plain wall-clock result, and `UTC` gives exactly ADR 0021's times.

The runtime computes this itself. It parses the fields in UTC, steps through matching wall-clock times with `Cron.next`, and maps each wall-clock time to an instant with the zone's offsets from Effect's `DateTime` (`Intl`). It doesn't use `Cron.next`'s own zone handling, because of the gap behaviour measured in [Context](#context).

### 4. Scheduled times of an interval

`@every d` fires at every instant that is a whole multiple of _d_ since the Unix epoch (1970-01-01T00:00:00Z). The next tick after _t_ is `(floor(t / d) + 1) × d`. Interval ticks are the same on every runner and for every actor, don't drift with handler time or relay lag, and ignore time zones and daylight saving. `@every 1 day` fires at 00:00 UTC. A schedule that should follow a local midnight is a zoned expression (`CRON_TZ=Europe/Paris 0 0 * * *`).

### 5. The catch-up rule for zones and intervals

ADR 0021's catch-up rule applies unchanged, with "scheduled time" as defined in sections 3 and 4:

- Each entry has at most one pending tick. After downtime, the pending tick fires once if `now − scheduled_at_ms ≤ cronSkipIfOlderThan` and is skipped otherwise. Either way the next tick is the first scheduled time after now, so missed zoned times and missed intervals are never replayed one by one.
- `scheduled_at_ms` is an instant, so lateness and the skip window are elapsed time, not wall-clock time. A tick for a skipped time is late from the first instant after the gap.
- A pending tick for the first occurrence of a repeated time that is still inside the skip window fires once, late. Its rewrite goes to the first scheduled time after now, which is never the second occurrence.
- An interval's pending tick fires once after downtime, and the next tick is the next multiple of the interval after now, not the missed tick plus the interval.

### 6. Time-zone data

Offsets come from each runner's time-zone database. The runner that writes or rewrites a tick computes its instant, and the row stores that instant. A time-zone database update therefore affects only ticks written after it. Two runners with different data during a rolling deploy can compute different instants for the same entry, but each entry has one pending row with one instant, so the difference moves a tick and never duplicates one.

## Open questions and recommended defaults

Each has a recommended default that this ADR adopts.

**Resolution (2026-09-28).** Dallen accepted the ADR with every default below.

1. **How an entry names its zone.** Recommended: a `CRON_TZ=<zone>` prefix in the record key. It keeps `policy.cron` a record of commands and lets one actor declare one expression in several zones. Alternatives: a per-entry object value (`{ command, timeZone }`), which can't declare one expression twice on one actor, because record keys are unique; or an actor-level `cronTimeZone`, which can't mix zones on one actor.

   ```ts
   // Not adopted: a per-entry object value.
   cron: { "0 8 * * 1-5": { command: OpenDesk, timeZone: "America/New_York" } }
   ```

2. **Which occurrence of a repeated time fires.** Recommended: the first. The schedule then fires at the earliest point the wall clock shows the time, and the rule depends only on the instant. Alternative: the second occurrence, which matches a "standard time wins" reading but delays the tick by the transition's length.
3. **Where a skipped time fires.** Recommended, and required by M2: at the first instant after the gap, collapsing every skipped match into one tick. Alternative: shift each skipped time by the gap's length (Effect's `Cron.next`), which fires 02:30 at 03:30 and can fire several ticks just after the gap.
4. **Interval anchor.** Recommended: the Unix epoch, so ticks need no stored state and are the same on every runner. Alternatives: anchored to the actor's first tick, which spreads actors' ticks apart but makes the schedule depend on when a row was written; or a zone's local midnight, which reintroduces daylight saving into an interval.
5. **Interval bounds.** Recommended: whole milliseconds, at least 1 second, no upper bound. One second matches the finest cron field; shorter intervals would turn the relay into a busy loop.
6. **Zone spelling in the key.** Recommended: the zone as declared. Alternative: the runtime's canonical name, which differs between Bun and Node for aliases, so runners on different runtimes would disagree on keys.

## Alternatives

- **Use `Cron.next` with the zone as is.** Rejected. It fires a skipped time after the gap plus the gap's length (03:30 for 02:30), which breaks M2's rule.
- **Keep the key `$cron:<expression>` and store the zone in another column.** Rejected. The unique index is on the timer key, so one expression in two zones would still collide, and changing an entry's zone would silently reuse a row computed in the old zone.
- **Evaluate intervals from the previous tick (`scheduled_at_ms + d`).** Rejected. Catch-up would need the missed-tick arithmetic ADR 0021 avoids, and a skipped or failed tick would shift every later tick.
- **A separate `policy.every` for intervals.** Rejected. It would add a second policy with the same targets, skip window, key prefix, and relay path as `policy.cron`.

## Consequences

- One actor can run the same expression in several zones, each with its own row.
- Local business hours, local midnights, and fixed intervals no longer need a UTC translation in application code, and that translation no longer breaks twice a year.
- Every rewrite of a zoned tick reads the zone's offsets. That is a few `Intl` calls per tick on the runner, not a database statement, so statements per tick don't change.
- A zoned hourly or more frequent schedule has one longer gap in its fall-back hour, because the repeated wall-clock times don't fire.
- Declared zone spelling is part of the key, so respelling a zone (`US/Eastern` to `America/New_York`) moves the entry to a new row.

## Amendments

In this change:

- [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) section 5: the tick key, the UTC-only rule, and the catch-up rule are amended as above. ADR 0021's text stays as recorded.
- [Contract 05](../contracts/05-messaging.md): the tick key names the entry's zone or interval.
- [Contract 08](../contracts/08-background-work.md): zones, intervals, the daylight-saving rule, and catch-up for them.
- [Dispatch](../architecture/04-dispatch.md) and [storage layout](../architecture/03-storage-layout.md): the tick key format.
- [Server API](../api/01-server-api.md): the `CRON_TZ=` and `@every` forms and the new keys (target API until the implementation lands).
- [Decisions index](README.md) and [M2](../milestones/M2.md): list this ADR.

The implementation PR amends the conformance ledger and the support matrix with the evidence below.

## Required evidence

Shared cases in `conformance/cron.ts` on PGlite and Postgres, each moving the framework clock with `ActorTest.advance` to real transitions of a non-UTC zone:

- `fires a wall-clock time skipped by a spring-forward gap once, at the first instant after the gap` — the pending tick is due at the gap's end, fires once there, and is rewritten to the next day's time; nothing fires at the gap's end plus its length.
- `fires a wall-clock time repeated by a fall-back transition once, at its first occurrence` — one receipt at the first occurrence, none at the second, and the rewritten row is due the next day.
- `keeps one expression in two zones as two entries that fire at their own times` — two rows with distinct keys and due times, each firing once.
- `fires a fixed interval at multiples of its length and once after downtime` — ticks on epoch multiples; downtime longer than several intervals fires once and resumes on the next multiple.

Unit tests for the schedule function beside it: gap, overlap, and hourly and sub-hourly schedules in `America/New_York`, a southern-hemisphere zone, and a zone whose transition isn't one hour (`Australia/Lord_Howe`), rewrites from inside the repeated hour, and interval arithmetic. Declaration tests in `definition.test.ts`: keys for each form, an unknown zone, a zone on an interval, bad intervals, and duplicates.

No benchmark scenario is added: the change adds runner-side arithmetic per rewrite and no statement, and the existing `cron` scenario covers the relay path.

## Revisit conditions

- A need for sub-second intervals.
- A request to fire the second occurrence of a repeated time, or both.
- A deployment that runs runners on different runtimes whose zone aliases matter.
