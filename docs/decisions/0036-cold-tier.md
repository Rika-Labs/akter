# ADR 0036: The cold tier

**Status:** proposed (2026-09-28). Design only: nothing is built until hosted usage asks for it (slice L.2).

**Responsibility:** decide how the state and blobs of long-idle actors move to object storage and come back, crash-safely, without adding cost to warm turns.

**Authority:** design decision record.

**Owner role:** runtime architecture / storage.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0006](0006-scale-rules-placement-and-query-tiers.md) says hosted deployments will move the state and blobs of actors idle beyond a threshold to object storage, leaving a stub row that a wake rehydrates. At a trillion actors with about 1 KiB of state each, hot replicated storage alone is about 4.5 PB, so the tier is needed for cost, not throughput. It requires its own ADR before implementation. [ADR 0011](0011-direct-commands-outbox-and-performance.md) sketches it: after an initial default of 30 idle days, `value` becomes null with a `cold_ref` pointer, and "wake rehydrates them in the admission round trip". [Contract 06](../contracts/06-storage-ownership.md) says an idle actor's state MAY be offloaded, leaving a `cold_ref`, and the next turn MUST rehydrate it before the handler. [M4](../milestones/M4.md) writes this ADR as M4.12, docs only, and builds it as L.2 with this evidence: a wake rehydrates within the wake-latency target, and offload and rehydrate are crash-safe.

What exists today that the design must fit:

- `actor_state.value` is `bytea NOT NULL`, one row per key, with a `$version` row counting state migrations (`0003_routing_state`, `state/migration.ts`). `actor_blobs` holds chunked `bytea` per entry (`0009_blobs`). Both lead with `routing_key` and reference `actor_generations`.
- Waking an activation acquires a new generation on `actor_generations` and then reads `actor_state` ([server API](../api/01-server-api.md)). Warm turns reuse cached state and take two round trips as the target ([ADR 0020](0020-two-round-trip-turn-pipeline.md)). The measured wake is 3.7 ms p50 and 9.0 ms p99 against a 5–15 ms target ([performance](../verification/03-performance.md)).
- [Contract 03](../contracts/03-transactions.md): external calls MUST happen outside the transaction. So ADR 0011's "rehydrate in the admission round trip" cannot mean fetching an object inside the turn transaction.
- ADR 0006 forbids indexes on columns that change every turn, and global scans whose cost grows with stored actors. An "idle since" column updated by every turn would break both.
- `policy.hibernateAfter` (default 60 s) already marks the moment an activation goes idle. Keyed outbox timers already provide "fire at time T unless replaced", with a `(bucket, kind, due_at_ms)` index whose scans cost what is due ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)).
- Retention already bounds receipts and events ([ADR 0038](0038-retention-cleanup-and-receipt-horizon.md)), and [restore](../operations/04-backup-restore.md) restores one database snapshot.

## Decision

### 1. What goes cold and what stays

- **Moves:** an actor's keyed state rows and its `Actor.blob` entries.
- **Stays hot:** the `actor_generations` row (identity, generation, event sequence), receipts, events, outbox rows and timers, owned-table rows (they exist to be seen by SQL), connections, and workflow rows. Anything with due work or retention of its own keeps its own rules.
- **Not in scope:** tenant content blobs from ADR 0034 (proposed separately). Their lifecycle is per tenant.
- **Where it runs.** Only where an object store is configured: `Actors.layer({ coldStorage })`. Hosted deployments configure it. Self-hosted deployments may. PGlite never does. Without `coldStorage`, nothing goes cold.

### 2. Finding idle actors without touching warm turns

- When an activation hibernates, the runtime stages a keyed `actor_outbox` row with `kind = 'cold'` and `timer_key = '$cold'` on the actor, due at `now + policy.coldAfter` (default 30 days; `"never"` opts a type out). That's one outbox write per hibernation, not per turn. `$cold` becomes a reserved prefix like `$cron:` and `$effect:`.
- When an activation starts, the same statement group that acquires the generation deletes the `$cold` timer. That adds no round trip.
- So a `$cold` row falls due only for an actor that has slept continuously for `coldAfter`. Due-work scans find it through the existing index, and the cost is what is due, not what is stored.

### 3. Offload: upload first, then flip under the fence

`cold` is a third outbox kind beside `intent` and `effect`, because neither existing path fits: an intent is delivered as a command, which would wake the actor, and an effect runs an application executor. The relay claims due `cold` rows through the `(bucket, kind, due_at_ms)` index with the same lease and backoff as effects ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)), and hands each to a per-runner offload pool instead of delivering it. The pool runs the steps below and never activates the actor. A `cold` row never becomes a route intent or a dead letter.

- **Row shape.** `actor_outbox`'s columns stay `NOT NULL`. A `cold` row fills them with fixed values that describe it truthfully: `target_type` and `target_id` are the actor itself, `command` is `$cold`, `payload` is `null` (the JSON text), `caller` is the System caller with source `cold`, and `timer_key` is `$cold`. A check constraint ties the kind to those values: `kind = 'cold'` exactly when `command = '$cold'`, and then `timer_key = '$cold'`. No application command can be named `$cold`, since `$` is reserved.
- **Claim.** The relay's claim statement adds `kind = 'cold'` to the kinds it selects, but only on runners with `coldStorage` configured and a free offload permit. It moves `due_at_ms` to the end of a lease and increments `attempts`, exactly as an effect claim does. The pool renews the lease while it uploads.
- **Settle.** Step 3 deletes the row in the flip transaction. An abort (step 3 finds a newer generation) also deletes the row, because the wake that caused it already deleted or replaced the timer; the delete matches on the claim's lease. A failure (the object store is unavailable, the upload times out) sets `due_at_ms` to a capped backoff and records `last_error`, as a failed effect attempt does. There is no attempt limit, and a metric counts rows past eight attempts.

1. **Snapshot, outside any transaction.** Read the generation `g`, every state row, and every blob chunk. If the actor has none, delete the timer and stop.
2. **Upload.** Write one immutable object, a framework envelope holding the format version, the codec, the state `$version`, the state entries, and the blob entries, compressed with zstd. Its key is `<deployment>/<tenant>/<actor type>/<routing key>/<digest of the actor id>/<g>-<sha256 of the object>`. Upload with a create-only condition, so an existing key is never overwritten.
3. **Flip, in one single-shard transaction.** Lock the generation row `FOR UPDATE`. If the generation is still `g` and the actor is not already cold, set `cold_ref` and `cold_digest` on `actor_generations`, delete the actor's state and blob rows, and delete the `$cold` timer. Otherwise abort; the object becomes an orphan (§5).

A wake between steps 1 and 3 changes the generation, so step 3 aborts. A wake after step 3 sees `cold_ref` and rehydrates. The generation row lock orders the two.

`cold_ref` lives on `actor_generations`, and the state rows are deleted rather than set to null. The generation row is read on every wake anyway, and one pointer per actor needs no nullable `value` on every key. This amends ADR 0011's "`value` null and a `cold_ref` pointer" (open question 1).

### 4. Rehydrate: fetch before the transaction, write back inside it

1. **Receipts first.** Every external command already starts with `readAdmission` (`runtime/turn/admission.ts`), one statement before delivery that reads the database clock, the canonical payload, and any retained receipt. L.2 adds `cold_ref` and `cold_digest` to that statement. Receipts stay hot (§1), so a command whose receipt is retained replays its outcome from that read, as [contract 04](../contracts/04-receipts.md) requires. It never fetches the object, and an object-store outage cannot turn a replay into a failure. Intent deliveries resolve their receipt the same way before any fetch.
2. If the actor is not cold, the command proceeds exactly as today, so warm and ordinary wakes are unchanged. Otherwise, **outside any transaction,** the owner fetches the object and checks its SHA-256 against `cold_digest`.
3. **In the wake's statement group,** which acquires the generation, it checks that `cold_ref` is unchanged, writes the state rows and blob chunks back, and clears `cold_ref`. Then the turn runs as usual: its fence and receipt insert-or-resolve come next, in contract 02's order, so a duplicate that raced in after step 1 still replays. The state migration chain upcasts from the object's `$version` as for any stored state.

- **Failures.** An object-store failure or timeout, for a command that must run its handler, is `ActorError` `ActorUnavailable` with `retryAfter`, and the handle retries with the same command id. A digest mismatch or an undecodable envelope is a deterministic defect that leaves the actor cold and untouched for an operator.
- **Queries** never activate an actor. On a cold actor, a query fetches and decodes the object read-through, and writes nothing (open question 3).
- **Cost.** Only a cold wake pays for the fetch. The target is the wake-latency target plus one object-store GET, which L.2 must measure and publish.

### 5. Objects: garbage collection, restore, and regions

- An object becomes unreferenced when its actor rehydrates, or when step 3 aborts. Rehydration and aborts record the key in a small garbage table on the same shard. A sweeper deletes an object only after it has been unreferenced for longer than the database backup retention plus a grace, so a restored snapshot never points at a deleted object.
- **Restore** is otherwise unchanged. The object store is in the backup boundary: it must be versioned or replicated with at least the database's durability. The [restore procedure](../operations/04-backup-restore.md) gains a check that every `cold_ref` in the restored snapshot exists.
- **Regions.** Objects live in the tenant's home region. A tenant move (L.1, designed in ADR 0031, proposed separately) copies the tenant's objects, or rehydrates the tenant first.
- **Tenancy and security.** Keys are prefixed by deployment and tenant. Runners get credentials scoped to their deployment's prefix, and the object store is never reachable by clients. Per-tenant encryption keys are open question 5.

### 6. Compatibility

A cold object keeps the state `$version` it was written with. Its actor type's state chain must therefore keep every step a cold object still needs. L.2 records the `$version` on `actor_generations` beside `cold_ref`. A startup check refuses a shortened chain while cold actors still hold an older version, as ADR 0032 (proposed separately) does for events.

## Alternatives rejected

- **A last-active timestamp updated by every turn.** It is an index on a column that changes every turn, which ADR 0006 forbids, and a write on every warm turn.
- **A periodic scan of every actor.** Its cost grows with stored actors, not with actors due.
- **Fetching the object inside the turn transaction.** Contract 03 forbids network I/O there, and it would hold the generation lock across an object-store round trip.
- **Keeping one row per key with a null `value`.** It keeps every key row hot, and adds a nullable column to the hottest table for the cold case.
- **Offloading owned tables.** SQL visibility is the reason they exist (vision 03).
- **Deleting objects right after rehydration.** A restore to an earlier snapshot would then point at a missing object.

## Consequences

- Warm turns and ordinary wakes pay nothing. Each hibernation pays one timer upsert, and each wake deletes one timer in a statement it already sends.
- State durability for cold actors depends on the object store's durability as well as the database's.
- `durable.state` shows nothing for a cold actor. `durable.actors` needs a column that says the actor is cold.

## Amendments when L.2 is scheduled

This ADR is docs only. These amendments are listed for when it is accepted and built.

**Contracts.**

- [06 storage](../contracts/06-storage-ownership.md): `cold_ref` on the generation row; state and blob rows deleted on offload; rehydration fetches outside the transaction and writes back in the wake's statement group before the first handler.
- [03 transactions](../contracts/03-transactions.md): rehydration's fetch as an example of work outside the transaction.
- [05 messaging](../contracts/05-messaging.md): reserve the `$cold` key, and describe the `cold` outbox kind, which the relay claims but never delivers as a command.
- [09 recovery](../contracts/09-recovery.md): crash cases for offload and rehydration, and object loss.
- [10 security](../contracts/10-security.md): object keys and credentials scoped to the deployment and tenant.

**Earlier ADRs.** ADR 0011 (cold state: where the pointer lives, and rehydration before the admission round trip rather than in it) and ADR 0006 (the mechanism is now designed).

**API.** [Server API](../api/01-server-api.md): `policy.coldAfter`, and `Actors.layer({ coldStorage })` with an S3-compatible adapter.

**Architecture and operations.** [Storage layout](../architecture/03-storage-layout.md), [backup and restore](../operations/04-backup-restore.md) (object retention and the `cold_ref` check), [retention](../operations/retention.md), [observability](../operations/03-observability.md) (offloads, rehydrations, cold-wake latency, orphans), [runbooks](../operations/runbooks.md), and the [inspection views](../operations/inspection-views.md) (a cold marker on `durable.actors`).

**Verification.**

- [Conformance](../verification/01-conformance.md): a **Cold tier** gate row.
- [Failure matrix](../verification/02-failure-matrix.md): rows for a crash between upload and flip, a wake racing an offload, a crash between fetch and write-back, an object-store outage on a cold wake, a digest mismatch, and a restore that references old objects.
- [Performance](../verification/03-performance.md): a cold-wake latency case.
- [Support matrix](../operations/support-matrix.md): "Cold tier: designed (ADR 0036); not built".

## Migration

None now. L.2 needs one framework migration: `cold_ref`, `cold_digest`, and the cold state version on `actor_generations`; `'cold'` added to the `actor_outbox.kind` check (today `intent` or `effect`, from `0008_effects`), with the check that ties `kind = 'cold'` to `command = '$cold'` and `timer_key = '$cold'` (§3); and the object garbage table. No column becomes nullable. It is numbered when L.2 is scheduled, above whatever has merged by then.

## Open questions for Dallen, with recommended defaults

1. **Where the pointer lives.** Recommended default: `cold_ref` on `actor_generations`, with state and blob rows deleted. Alternative: ADR 0011's null `value` with `cold_ref` on each state row.
2. **How idle actors are found.** Recommended default: a `$cold` timer staged at hibernation and deleted on wake. Alternative: a periodic, rate-limited scan by bucket, which is simpler but costs what is stored.
3. **Queries on cold actors.** Recommended default: read-through without rehydrating. Alternatives: rehydrate on query, which makes queries write; or fail with `ActorUnavailable`.
4. **What moves.** Recommended default: state and actor blobs together. Alternative: state only, leaving blobs hot.
5. **Encryption.** Recommended default: the object store's server-side encryption with one key per deployment. Alternative: one key per tenant, which makes deleting a tenant's data cheap (crypto-shredding) and costs key management.
6. **Defaults.** Recommended default: off unless `coldStorage` is configured; when configured, `coldAfter` is 30 days, as ADR 0011 set. Alternative: a shorter hosted default after the L.2 cost model.

## Evidence required when L.2 is built

- A cold wake rehydrates within the published wake-latency target plus one object GET, measured on the hosted topology.
- Crash cases (SIGKILL on Postgres) at each step: after the snapshot, after the upload, and after the flip; after the fetch, and after the write-back. Each ends with the actor either warm with its last committed state, or cold with a readable object, never both and never neither.
- A wake racing an offload aborts the flip, and the next offload succeeds.
- A due `cold` row is claimed and offloaded without activating the actor or delivering any command, and a failed offload backs off without a dead letter.
- A restore to a snapshot taken before a rehydration finds its object.
- An object-store outage gives `ActorUnavailable` with `retryAfter` to a command that must run its handler, and a later retry with the same command id succeeds once.
- A duplicate of a command whose receipt is retained replays its outcome on a cold actor while the object store is unavailable, and fetches nothing.
- A `cold` row satisfies the kind check, is claimed only by runners with `coldStorage`, backs off on upload failure, and is deleted by the flip or by an aborted flip.
- A shortened state chain is refused while cold actors hold an older version.

## Revisit when

- Hosted usage makes idle storage a real cost (L.2's trigger).
- Object-store latency makes cold wakes miss the target, which would call for prefetching on the first frame or connection open.
- Owned tables grow large enough for idle actors that they need a cold tier of their own.
