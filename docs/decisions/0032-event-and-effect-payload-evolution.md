# ADR 0032: Event and effect payload evolution

**Status:** accepted (2026-09-28, Dallen, with every recommended default; proposed 2026-09-28). M4.7 builds it in `0021_payload_versions`.

**Responsibility:** decide how stored event values and effect payloads keep decoding after their schemas change.

**Authority:** design decision record.

**Owner role:** runtime / API.

**Change policy:** supersede through a new ADR.

## Context

Keyed state already evolves. `Actor.state(fields, { migrations })` takes a chain of `Actor.migration(from, to, upcast)` steps, `Actor.make` validates it, and stored state carries a `$version` row counting the migrations applied (`state/migration.ts`, [server API](../api/01-server-api.md)). A turn upcasts older rows before the handler and writes the current shape on commit. A stored version newer than the chain, or an upcast that throws, is a deterministic defect ([contract 06](../contracts/06-storage-ownership.md), invariant S1).

Events and effects have nothing like it:

- **Events.** `turn.emit` stores the schema-encoded value as zstd `bytea` in `actor_events`, with the tag in `event` and no version (`0006_events`). Every reader decodes with the class's current schema: `read.events` and the connection context both go through one decode in `actor/definition.ts` under `Effect.orDie`, so an event that no longer decodes fails the query ([M1](../milestones/M1.md) M1.5; [M4](../milestones/M4.md) M4.7). Served event feeds ([ADR 0027](0027-served-protocol.md) §7), subscription deliveries ([ADR 0026](0026-cross-actor-event-subscriptions.md)), and workflow waits ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)) read the same rows.
- **Effects.** `turn.perform` stores the encoded effect as JSON text in `actor_outbox.payload` (`0008_effects`). The executor decodes it on every attempt; a payload that no longer decodes fails the attempt as a non-ambiguous error, so it is retried and then dead-lettered (`actor/definition.ts`). A dead letter keeps the payload in `actor_dead_letters.payload`, and dead letters are never pruned ([retention](../operations/retention.md)). The `onDeadLetter` route's input, `Actor.DeadLetter(E)`, embeds the effect.
- **The rules we have.** [Versioning](../api/versioning.md) says retained events and pending messages must decode for their full retention window, and evolution is additive by default. [Migrations](../operations/02-migrations.md) says not to contract an event schema or effect payload until every retained record has passed its horizon. Nothing enforces either rule, and an additive change cannot rename a field, change a unit, or split a field.

Events are history, so unlike state they cannot be rewritten on the next turn. They are kept for `keepEvents` (30 days by default) and read by other actors, by clients, and by workflows. Effect rows usually live for seconds, but they can wait through a long retry backoff, and dead letters wait for an operator.

A general example: an `Order` actor emits `OrderPlaced { orderId, amount }` where `amount` is a number of US cents. The team adds currencies and wants `OrderPlaced { orderId, total: { amount, currency } }`. Today they must keep `amount` forever or break every stored event.

## Decision

### 1. Events and effects declare a migration chain, as state does

```ts
class OrderPlaced extends Actor.Event<OrderPlaced>()(
  "OrderPlaced",
  { orderId: OrderId, total: Money },
  {
    migrations: [
      Actor.migration(
        { orderId: OrderId, amount: Schema.Number },
        { orderId: OrderId, total: Money },
        (v1) => ({
          orderId: v1.orderId,
          total: { amount: v1.amount, currency: "USD" },
        }),
      ),
    ],
  },
) {}

class ChargeCard extends Actor.effect<ChargeCard>()("ChargeCard", {
  input: { orderId: OrderId, total: Money },
  success: Receipt,
  migrations: [Actor.migration(ChargeV1Fields, ChargeV2Fields, upcastCharge)],
}) {}
```

- The chain reuses `Actor.migration` and the state chain's rules: each `to` is the next `from`, the last `to` is the class's current fields, and an invalid chain throws when the class is built. The tag is not part of `from` or `to`; it never changes.
- A value's **payload version** is the number of steps applied to reach its shape, exactly like state's `$version`. Code with `n` steps writes version `n`.
- A chain has one way to shorten: drop its first steps once no retained value needs them (§4). The dropped count is declared as `migrations: { from: k, steps: [...] }`, so version numbers never shift.

### 2. The version is stored beside the value

- `actor_events` gains `payload_version integer NOT NULL`. `turn.emit` writes the class's current version.
- `actor_outbox` gains the same column. Effect rows get the effect's current version; intent rows keep `0` (command inputs are out of scope, §6). When the relay settles an effect, it rewrites the row into its `onSuccess` or `onDeadLetter` route intent in one statement, and that statement also sets `payload_version` back to `0`, because the row now carries a command input.
- `actor_dead_letters` gains the same column and copies it from the effect row.
- Nothing is released, so no stored value predates this column. Version `0` is simply the first shape of a class, the one with no chain steps.

A column, rather than a reserved field inside the value, keeps values in the class's own encoding, lets SQL and the [inspection views](0028-sql-inspection-views.md) show the version, and lets the startup check (§4) read versions without decompressing values.

### 3. Values upcast when read and are never rewritten

- **Events** decode through the chain from their stored version on every read: `read.events`, connection contexts, served feeds, subscription deliveries, and workflow waits. Stored events are never rewritten, so history stays exactly what the turn committed, and no operation touches every stored event.
- **Effects** decode through the chain on each attempt. A dead letter decodes through the chain when the relay builds its `onDeadLetter` route input, so the route receives the current shape.
- **Failure stays loud.** A stored version newer than the code's chain, or an upcast that throws or produces an invalid value, is a deterministic defect for that read, as for state. For an effect attempt, the failure happens before the executor is called, so this attempt never reached the provider. The attempt fails and is retried, but it never clears the row's ambiguity: if an earlier attempt recorded `ambiguous: true` (a defect, or a crash after the call may have started), the row and any dead letter keep it. Only a typed executor failure makes an attempt non-ambiguous, as [contract 08](../contracts/08-background-work.md) says. Today's code reports a decode failure as non-ambiguous and overwrites the flag; M4.7 changes that to keep the flag. Contract 05's rule that replay never silently skips an event still holds.
- **Receipts don't change.** A subscription delivery's receipt binds the delivery identity, not the re-encoded event ([contract 04](../contracts/04-receipts.md)), so upcasting a redelivered event does not cause `CommandConflict`.

### 4. A deploy that would strand a stored value is refused

- A new table, `actor_payload_versions (actor_type, kind, tag, version, first_written_at_ms, superseded_at_ms, cleared_at_ms)`, records every version that may be stored. `kind` is `event` or `effect`.
  - At layer build, a runtime records the version it will write for each declared event and effect: its `writeVersion` when set (§5), and otherwise the chain's last version. It inserts the row if it is missing, and sets `superseded_at_ms` on lower versions of that tag that have none. This is one statement per build, not per turn, and it runs before the runtime takes any shard, so every stored value's version has a row.
- `Actors.layer` refuses to start, as a placement mismatch or a workflow manifest mismatch does ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md) §7), when:
  1. a recorded version is above the last version the code's chain can read for that tag, which is a rollback past a schema change; or
  2. the code's chain starts above a version that may still be stored. An event version counts as stored until its row has `cleared_at_ms`. The retention horizon alone is not proof, because a sweep can lag or a restore can bring rows back. Effect versions may be stored while any `actor_outbox` or `actor_dead_letters` row has that version, which the check reads directly because those tables are small.
- `durable payloads check --entry ./src/actors.ts` runs the same check read-only for CI, like `durable workflows check`.
- `durable payloads clear --entry ./src/actors.ts` is the only way an event version gets `cleared_at_ms`. It considers only versions whose `superseded_at_ms + keepEvents` has passed. For each one, it looks for any `actor_events` row of that actor type, tag, and version (`LIMIT 1`, on a dedicated connection, as operator maintenance, never on a turn path), and sets `cleared_at_ms` only when it finds none. A restore brings back its own copy of `actor_payload_versions`, so a snapshot from before a clear is refused again until the scan passes on the restored data.
- **Old writers are fenced before a clear.** A scan alone can race a runner that still writes the old version. So every runtime keeps a row per version it writes in `actor_payload_writers (runtime_id, actor_type, kind, tag, version, refreshed_at_ms)`. It refreshes the row before it takes any shard and then every minute, on the loop that already runs retention sweeps. A runtime whose last successful refresh is older than the writer window W (default 2 minutes) refuses new turns until it refreshes. That check is local to the runtime, so warm turns pay no statement for it. `durable payloads clear` refuses a version while any writer row for it was refreshed within the last W plus the longest `commandTimeout`. After that point, no runtime can start a turn that writes the version, and any turn already running has ended. Only then does it scan and set `cleared_at_ms`, in one transaction that re-checks the writer rows, so a writer that comes back during the scan makes the clear fail. This also enforces M4.4's version-skew rule, instead of trusting operators to follow it.

### 5. Rolling deploys write the old version until every runner reads the new one

With several runners on one database, a new runner's events would reach old runners that cannot decode them. A deploy that adds a step therefore runs in two phases, the expand-and-contract pattern [migrations](../operations/02-migrations.md) already asks for:

1. Ship the new step with `writeVersion: n − 1`. Every runner can now read both versions; each still writes the old one.
2. Once every runner runs that code, drop `writeVersion`. New values use version `n`.

`writeVersion` needs a downcast for that one step: `Actor.migration(from, to, upcast, { downcast })`. A single-runner deployment, or one that stops every runner to deploy, skips phase 1 (open question 2).

### 6. Scope

- **In scope:** event values, effect payloads, and the effect inside a dead letter.
- **Out of scope:** command inputs in pending intents and timers, command outputs and declared failures in receipts, workflow step exits, and connection sessions. Command inputs and outputs follow the additive rules in [versioning](../api/versioning.md). Workflow exits keep ADR 0022's manifest check, which refuses a changed step result while an open execution recorded it. A workflow wait records the event as the current class decodes it, so changing an event's schema still waits for open executions that recorded a wait on it.
- **Tag renames and removals.** A tag is the event's identity. Renaming it is a new event class; the old class stays declared while its events are retained. Removing a class whose events are still retained is allowed only when no durable consumer can still read them. Startup refuses the removal while any subscription row still follows that tag and has undelivered events of it (ADR 0026's `retired` form drains a subscription first), or while an open workflow execution's manifest waits on it (ADR 0022's check already refuses this). Otherwise nothing reads those events by that tag, and retention removes them. The same check covers shortening a chain below a version that a pending subscription delivery still has to decode.

## Alternatives rejected

- **Rewrite stored events to the new shape.** It changes history that subscribers, feeds, and clients may already have seen, costs a scan of every stored event, and races with readers.
- **Try the current schema, then older ones.** Two shapes can both decode the same bytes, so the result would depend on the order of attempts.
- **A version field inside the encoded value.** It changes the class's own encoding, leaks into feeds and inspection, and needs decompression to find a version.
- **Only additive changes.** That is today's rule, and it cannot express a rename, a unit change, or a split.
- **Upcasting in application code.** Every reader (queries, feeds, subscriptions, workflow waits) would repeat it, and the framework could not check that stored values still decode.

## Consequences

- An event or effect schema change becomes a declared, tested migration, like a state change.
- Reads pay one upcast per step for old values. Most events are read soon after they are written, at the current version.
- A dead letter keeps its effect's early chain steps alive until an operator resolves it.
- Rolling deploys of a changed event take two releases. The runtime enforces the rule that [migrations](../operations/02-migrations.md) only described.

## Amendments on acceptance

These landed with the acceptance, as labelled targets until the slice builds them.

**Contracts.**

- [05 messaging](../contracts/05-messaging.md): every committed event stores its payload version; replay, feeds, subscriptions, and workflow waits decode through the event's chain; a value the chain cannot decode is a defect, never a skip.
- [08 background work](../contracts/08-background-work.md): effect payloads and dead letters store their payload version and decode through the effect's chain on each attempt and when building a route.
- [06 storage](../contracts/06-storage-ownership.md): the migration section names events and effects beside keyed state.

**API.**

- [Server API](../api/01-server-api.md): `Actor.Event<Self>()(tag, fields, { migrations? })`, `Actor.effect<Self>()(tag, { input?, success?, progress?, migrations? })`, the `{ from, steps }` form for shortened chains, `writeVersion`, and `Actor.migration`'s optional `downcast`.
- [Versioning](../api/versioning.md): replace "retained events and pending messages must decode" with the enforced rule for events and effects; keep the additive rule for command inputs and outputs.
- CLI: `durable payloads check`.

**Operations.** [Migrations](../operations/02-migrations.md) gets an event and effect section: declare the chain, deploy in two phases on several runners, and shorten a chain only after the check passes. The [inspection views](../operations/inspection-views.md) add `payload_version` at the end of `durable.events`, `durable.effects`, and `durable.dead_letters`, which ADR 0028 §2 allows within a view version.

**Verification.**

- [Conformance](../verification/01-conformance.md): a **Payload migration chain** gate row, and `conformance/payload-migrations.ts` with the cases below.
- [Invariants](../verification/invariants.md): extend S1 to events and effects, or add an E-row: "a retained event decodes through its chain for its whole retention window".
- [Failure matrix](../verification/02-failure-matrix.md): "Deploy drops a chain step a retained value needs" and "Rollback past a payload schema change", both refused at startup.

## Migration

Needs one framework migration: `payload_version` on `actor_events`, `actor_outbox`, and `actor_dead_letters`, and the `actor_payload_versions` and `actor_payload_writers` tables. It is `0021_payload_versions`, reserved for M4.7 when this ADR was accepted; `0021_adoption` moved up, and adoption is now `0024_adoption`.

## Decided questions

Dallen accepted every recommended default on 2026-09-28.

1. **Read-time upcast only, or also an operator rewrite?** Decided: read-time only. Rejected alternative: add `durable events migrate` to rewrite retained events in batches, so old chain steps can be dropped before `keepEvents` has passed.
2. **Two-phase deploys with `writeVersion` and a downcast.** Decided: yes, because M2 made several runners per database a supported shape. Rejected alternative: require stopping every runner for a deploy that adds a step, which is simpler and costs downtime.
3. **Command inputs in pending intents.** Decided: out of scope; they stay additive-only. Rejected alternative: give `Actor.command` inputs the same chain, which also touches receipts' payload hashes and needs its own ADR.
4. **Workflow waits.** Decided: keep ADR 0022's rule that an event schema change waits for open executions that recorded a wait on it. Rejected alternative: fingerprint the chain instead, so recorded waits upcast too.
5. **Migration number.** Decided: reserve the next free number at acceptance. It is `0021_payload_versions`. Rejected alternative: wait for merge time and apply the milestone renumbering rule.

## Evidence required

In `conformance/payload-migrations.ts`, on PGlite and Postgres:

- `upcasts version-0 events written before a chain step was added through the chain in read.events, feeds, and subscription deliveries`
- `stores the current payload version with each emitted event and performed effect`
- `runs a pending effect written at an older version with the upcast payload`
- `delivers an onDeadLetter route with the upcast effect and keeps the dead letter's version`
- `resets payload_version to 0 when a settled effect row becomes its route intent`
- `fails a read as a defect, never a skip, when an upcast throws or the stored version is newer than the chain`
- `keeps an earlier attempt's ambiguity on the row and in the dead letter when a later attempt fails to decode its payload`
- `refuses startup after a rollback past a recorded version, and when a shortened chain drops a version still retained`
- `refuses a shortened chain after the retention horizon until durable payloads clear finds no row of the dropped version, and refuses again after restoring a snapshot taken before the clear`
- `refuses durable payloads clear while a runtime writing that version refreshed within the window, and a runtime past its window refuses new turns until it refreshes` (Postgres, two runtimes)
- `records the writeVersion, not the chain's last version, while a two-phase deploy is in its first phase`
- `writes the old version under writeVersion and reads both versions on one runtime`
- `refuses removing an event class while a subscription has undelivered events of that tag or an open workflow waits on it`
- `replays a subscription receipt after a schema change without CommandConflict`

On Postgres only: `applies the migration to a database that ran the previous one`, and a two-runner case where one runner has the new chain and both keep reading under `writeVersion`.

Benchmark: `events-replay` with values one and three steps behind, against current-version values.

## Revisit when

- Command inputs or receipt outputs need non-additive changes.
- Read-time upcasting shows up in replay latency.
- Workflow waits block event schema changes too often.
