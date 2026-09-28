# ADR 0030: Executor progress frames

**Status:** accepted (2026-09-28, Dallen, with every proposed default; proposed 2026-09-27). The executor side is implemented; delivery to owners, holders, connections, and streams is M2.18. The amendments listed under [behaviour changes](#behaviour-changes-against-existing-contracts) have landed as labelled targets, and the [decided questions](#decided-questions) record the defaults. [ADR 0048](0048-mint-progress-and-inspection-record-corrections.md) amends the close bound, the final frame under the runner-wide cap, and what `seq` counts.

## Context

An effect executor can run for minutes: a video transcode, a bulk import, a report build. Until its result commits through `onSuccess`, the actor and its clients see nothing. Applications want to show "40% done" or "12,000 of 50,000 rows" while the call runs, and today they have two bad options:

- **Send a command per step.** Each step becomes a turn, a receipt, and a state write on the owner's shard. That makes transient progress durable, costs a transaction per tick, and puts a hot write on one actor for work that was supposed to live outside turns.
- **Build a side channel.** The executor writes to a cache or pub/sub that the client also reads. That bypasses the actor's authorization, tenant scope, and connection lifecycle.

The constraints this ADR must fit:

- **Executors have no database capability** ([contract 08](../contracts/08-background-work.md), [server API](../api/01-server-api.md)). `X.Executor` exposes `effectId`, `attempt`, `principal`, and the performing actor's `ref`; an effect layer that requires a SQL client does not compile. Nothing here may give an executor a way to write rows, state, events, or receipts.
- **Executors run on any runner.** Under [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) any runner with the executor claims the effect row, runs the attempt on its pool outside any transaction, and renews a lease. Attempts can overlap after a lease loss, the first success wins, and the settle statement turns the row into its route intent.
- **Only committed state publishes** ([contract 07](../contracts/07-realtime.md)). `X.Read` and `X.Connection` expose committed state only, and committed changes publish only after commit.
- **Every frame to a connection leaves through the owner activation.** [ADR 0023](0023-connections-parking-and-streams.md) §6 already reserves the path: "framework-originated frames, such as executor progress, are delivered to the owner's connection entity like a frame, wake the activation there, and are broadcast by it, so every frame to a connection leaves through one activation's ordered channel." Connections are held by a holder runner; the owner sends frames over one ordered, sequenced channel per holder; a holder that sees a sequence gap closes the connection with `SlowConsumer`, and a full outbound buffer (1,024 frames or 1 MiB) does the same. Contract 07 says single frames and stream elements MUST NOT be dropped or coalesced, and invariant C4 says live output is never silently lost.
- **Effects can be cancelled** ([ADR 0024](0024-effect-cancellation-and-per-actor-concurrency.md), accepted). A cancelled attempt is interrupted best-effort within `cancelCheck` and reported through `onCancelled`.
- **Authorization** is per session: the holder reauthorizes each connection every `reauthorizeEvery`, and a stream's owner reauthorizes its subscriber ([contract 10](../contracts/10-security.md), ADR 0023 §8).

M2.17 decides the design; M2.18 builds it after M2.10 (connections) and M2.4 (the multi-runner relay), with its cases in `conformance/progress.ts`. M3.3 carries progress over WebSocket.

## Decision

### 1. Progress is a declared, transient side channel of an effect

An effect declares a progress schema next to its `success` schema:

```ts
// media/effects.ts
export class Transcode extends Actor.effect<Transcode>()("Transcode", {
  input: { assetId: AssetId, preset: Schema.String },
  success: TranscodeResult,
  progress: Schema.Struct({
    percent: Schema.Number,
    stage: Schema.Literal("probe", "encode", "upload"),
  }),
}) {}
```

The executor reports progress through `X.Executor`:

```ts
// media/effects.ts
export const MediaEffects = Media.toEffectLayer(
  Effect.gen(function* () {
    const encoder = yield* Encoder
    return {
      Transcode: Effect.fn(function* ({ assetId, preset }) {
        const exec = yield* Media.Executor
        const job = yield* encoder.start(assetId, preset, { idempotencyKey: exec.effectId })
        yield* job.progress.pipe(
          Stream.runForEach(({ percent, stage }) => exec.progress(Transcode, { percent, stage })),
          Effect.forkChild,
        )
        return yield* job.result
      }),
    }
  }),
)
```

- `exec.progress(E, frame)` is `Effect<void, never, never>`. It never fails, never suspends on the network, and never changes the effect's outcome: its work is to encode the frame and offer it to a bounded local slot (section 4). The effect class argument types the frame against `E`'s `progress` schema and is checked at runtime against the running effect's tag; passing another effect's class or calling it for an effect that declares no `progress` is a type error, and at runtime drops the frame with the warning `Progress frame does not match the running effect`.
- A frame that fails to encode, or whose encoding exceeds 4 KiB, is dropped with a warning (`Progress frame did not encode` or `Progress frame exceeds 4 KiB`) and counted. It is never a defect, because a defect makes the attempt's outcome unknown and ambiguous (invariant P1), and a cosmetic side channel must not do that.
- A `progress` captured and run after its attempt ended (after the executor returned, failed, or was interrupted) is a no-op. It does not die: the attempt that owned it is over, and dying in unrelated code would be worse than dropping a frame.
- Progress frames are **not** state, events, receipts, outbox rows, dead-letter data, or telemetry payloads. Nothing about them is written to Postgres. They appear in no replay, `events` read, `Resync` replay, SQL inspection view, backup, or export.

### 2. Who receives progress: opted-in connections and streams of the owner actor

Progress goes only to the performing actor's own sessions, and only to those that opted in. There is no progress feed on handles, commands, queries, receipts, or `WorkflowRun`.

**Connections** opt in on the member:

```ts
export const Live = Actor.connection("Live", {
  server: Schema.Union([AssetReady, AssetFailed]),
  client: Schema.Never,
  progress: { effects: [Transcode], to: "performer" },
})
```

- `effects` lists the effect classes whose progress this member receives; each must be declared in the actor's `effects` with a `progress` schema (checked in types and at `Actor.make`).
- `to` selects the audience among this member's open connections: `"performer"` (the default) delivers only to connections whose stored caller has the same principal as the effect's `X.Executor.principal`, which is the performing turn's principal; `"all"` delivers to every open connection of the member. An effect performed by a turn with no principal (a `System` caller with no `onBehalfOf`, such as a cron tick) reaches no connection under `"performer"`. Delivery to a connection is further bounded by that connection's own authorization for the member, which the holder enforces as for any frame (section 6).
- Progress reaches clients in its own envelope variant, apart from member frames and control frames (section 7), so it is never mistaken for either, and adding progress to a member does not change its `server` schema.

**Streams** opt in on the member with `progress: { effects }`, and read it in their handler. `X.Read` gains `progress(E, options?)`, available only inside an `Actor.stream` handler whose member lists `E`:

```ts
export const Encoding = Actor.stream("Encoding", {
  input: { assetId: AssetId },
  output: Schema.Union([EncodingProgress, AssetReady]),
  errors: [NotOwner],
  progress: { effects: [Transcode] },
})

// in Media.toLayer
Encoding: ({ assetId }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const read = yield* Media.Read
      yield* access.requireOwner(read.caller, assetId)
      const progress = read.progress(Transcode).pipe(
        Stream.filter((p) => p.effect.assetId === assetId),
        Stream.map((p) => new EncodingProgress({ percent: p.frame.percent })),
      )
      return Stream.merge(progress, read.follow(AssetReady).pipe(Stream.map((e) => e.event)))
    }),
  )
```

- `read.progress(E, { effectId? })` is a live `Stream` of `ProgressEntry(E)` = `{ effectId, effect, attempt, seq, frame }` for effects of type `E` performed by this actor, from the moment the stream subscribes. It has no history and never completes on its own; it ends with the stream's subscription or activation.
- The stream handler is the authorization and audience decision: it runs as the subscriber, and the owner reauthorizes the subscriber on its timer (ADR 0023 §8). Anything the handler emits is an ordinary stream element under contract 07's stream rules.
- `read.progress` is not available in queries, command turns, connection handlers, or workflows; there it is a type error (it requires a stream-only service) and dies at runtime with `Progress is only available in stream handlers`.

An actor with neither a connection member nor a stream member that lists `E` in `progress.effects` never receives `E`'s progress; section 3 makes the executor side skip the send entirely in that case.

### 3. Path: executor pool to the owner's connection entity, then out through the owner's channels

1. **Executor side.** The runner's executor pool holds one progress slot per running attempt. `exec.progress` writes the encoded frame into that slot, replacing any frame still waiting there (latest wins), and increments the attempt's progress sequence. The pool sends the slot's frame at most once per `progressEvery` (default 250 ms) per attempt. Before sending the first frame of an effect type, the pool checks the owner actor type's definition: if no connection or stream member lists the effect in `progress.effects`, the pool never sends and drops frames silently except for a debug counter. This check is static per actor type and costs nothing per frame.
2. **Message.** Each send is one fire-and-forget Cluster message to the performing actor's connection entity (ADR 0023 §4), routed to the owner on whichever runner holds the shard:

   ```ts
   Progress {
     ref: ActorRef            // tenant, type, id
     effectId: string
     effect: string           // tag
     attempt: number
     seq: number              // per attempt, from 1, counts progress calls
     leaseUntil: number       // the attempt's lease deadline on the database clock, as last renewed
     frame: Uint8Array        // encoded under the effect's progress schema
   }
   ```

   It has no retry, no acknowledgment, and no resend; a lost message is a lost frame. It never passes through the command mailbox or counts against `mailboxCapacity`, like every connection-entity message.

3. **Final frame and close.** When the executor returns or fails, the pool closes the slot, sends its pending frame, if any, before it runs its settle statement, without waiting for delivery, and never sends another frame for that attempt. The settle is not delayed by progress. After a **terminal** settle commits (success, a declared or exhausted failure, or a dead letter), the pool sends the owner one fire-and-forget `ProgressClosed(effectId, attempt)`. A retryable failure's settle keeps the row for the next attempt and sends nothing: the effect stays open, the failed attempt's slot is already closed, and the next attempt's frames carry a higher `attempt`. It matters for an effect whose settle deletes its row without a route turn (success with no `onSuccess`, exhaustion with no `onDeadLetter`), where no owner turn would otherwise close the effect.
4. **Owner admission.** The owner activation accepts a `Progress` message only if all of these hold, and otherwise drops it and counts the reason:
   - its `ref` names this activation's actor, tenant included;
   - the effect tag is declared with `progress` and at least one opted-in member or open `read.progress` subscription wants it;
   - `leaseUntil` has not passed on the owner's clock (allowing the same 1 second of skew as `authorizedUntil`);
   - the effect is **open** on this activation: the activation has not committed that effect's route turn (`onSuccess`, `onDeadLetter`, or `onCancelled`, whose command id is the effect id) or a turn that cancelled it (ADR 0024's `cancelEffect`, or a `perform` that replaced its key);
   - `attempt` is not lower than the highest attempt this activation has accepted for the effect, and `seq` is higher than the last accepted `seq` for that attempt, so an activation never emits an attempt's frames out of order or older attempts' frames after newer ones;
   - the actor's progress rate budget has room (section 4).

   The first `Progress` for an effect id on an activation also runs one **effect check**: a single-row read of `actor_outbox` by primary key `(routing_key, intent_id = effectId)` returning `kind`, `attempts`, (after ADR 0024) `cancelled_at_ms`, and, only when a stream member lists the effect, its `payload`, in a short framework read outside any turn. The effect is open only if the row still exists as `kind = 'effect'`, is not cancelled, and `attempts >= attempt`. The owner decodes that payload once into the effect instance that `ProgressEntry.effect` carries, so the executor never resends the input with each frame. The result is cached on the activation for the effect id for at most 5 seconds; later route or cancel commits on this activation, and a `ProgressClosed` for that attempt or a later one, close it. A frame that arrives after the cached result expires runs the check again, so if a `ProgressClosed` is lost, an effect with no route can show delayed progress for at most 5 seconds after its settle; while an effect reports, the check costs one read per effect per 5 seconds. A check that fails (database unavailable) drops the frame and is retried on the next frame after 1 second; it never fails a turn, closes a session, or wakes anything else. The check is one indexed single-shard read, never per frame, and adds nothing to any turn's statements.

5. **Waking.** A `Progress` message wakes a parked activation, as ADR 0023 §6 requires for framework-originated frames. Because of step 1, it only does so for actor types that opted in. Accepted progress counts as activity for `hibernateAfter` so an actor with a running, reporting effect does not cycle between waking and parking; rejected progress does not.
6. **Fan-out.** For connections, the owner resolves the audience (section 2) from its connection list. ADR 0023 §6 item 1 loads only `(connection_id, holder, holder_epoch)`; for a member that declares `progress` with `to: "performer"`, this ADR amends that load to also read the row's `caller` column, which `actor_connections` already stores, in the same statement and pages, so a cold activation woken by progress can select the performer's connections without another read. Opens and closes keep the in-memory list and its callers current as they do today and hands one progress message per holder to the same ordered, sequenced channel it uses for broadcasts (ADR 0023 §6 items 2–4), so it takes a channel sequence number and a holder never sees a sequence gap because of progress. It carries no `event` cursor. For streams, the owner offers the entry to every open `read.progress` subscription for the tag.

### 4. Loss, ordering, rate, and size

Progress is **best-effort, lossy, and never silently mistaken for continuity**. A loss followed by a delivered frame of the same attempt is visible as a gap in `seq`; the loss of an attempt's last frames is not, and a client learns the outcome only from committed state, events, or the route's frames. Nothing durable depends on progress.

- **Ordering.** For one attempt on one session, delivered frames have strictly increasing `seq`. A frame from a higher attempt may follow; after it, no frame from a lower attempt is delivered by that activation. Across an owner move, a new activation starts with empty per-effect state, so it may deliver a lower attempt's frame than the old activation last delivered; `attempt` is on every frame, and clients keep the highest `(attempt, seq)` they have seen.
- **Relation to results.** An activation never delivers a progress frame for an effect after it committed that effect's route turn or a turn that cancelled it, and a new activation never delivers one after the route intent or cancellation exists, because the effect check finds the row settled or cancelled. When it closes an effect it had forwarded progress for, the activation sends each holder it forwarded to a `ProgressEnd(effectId)` on the same ordered channel, before the route turn's own broadcasts; the holder discards any undelivered progress for that effect in its outbound buffers and drops any that follows. On one connection, therefore, no progress frame for an effect is delivered to the client after that effect's route broadcast, or after the holder learns of its cancellation or settle, however slowly the client reads. The reverse is not promised: the route's broadcast may arrive without the last progress frames before it. An effect with no route turn is closed by `ProgressClosed` or, if that is lost, by the effect check within 5 seconds of its settle. Progress is scoped to the owner generation that forwarded it: when a holder receives any message for an actor from a higher owner generation than its buffered progress (the new owner's `Resync` or first broadcast), it first discards that actor's undelivered progress from older generations, so a paused client never sees an old owner's progress after a new owner's route broadcast, whether or not the new owner ever forwarded progress to that holder. When a lease renewal returns `cancelled_at_ms` (ADR 0024), the pool closes the attempt's slot at once and sends `ProgressClosed(effectId, attempt)` before interrupting the executor, so a cancellation committed anywhere stops the attempt's progress at the pool within one renewal period, independent of any owner's cached effect check.
- **Coalescing and drops, a labelled exception to contract 07.** The rules that single frames and stream elements MUST NOT be dropped or coalesced, and that an overflowing buffer closes the session with `SlowConsumer`, do not apply to progress frames:
  - The executor pool coalesces an attempt's frames latest-wins at `progressEvery`.
  - A holder that already has an undelivered progress frame for the same `(connection, effectId)` in a connection's outbound buffer replaces it with the newer one in place.
  - A holder never closes a session because of progress: a progress frame that would exceed the connection's 1,024-frame or 1 MiB limit, or the holder's 256 MiB budget, is dropped instead. Buffered progress counts toward those limits, but a member frame that would exceed them first evicts buffered progress, oldest first, and only then applies the member-frame rules, so progress never causes `SlowConsumer` and never lets the buffer exceed its limits.
  - Each `read.progress` subscription has its own sliding buffer of 16 entries in front of the stream's 256-element window; when it is full the oldest entry is dropped. Elements a stream handler actually emits keep the stream rules.
  - The holder still assigns progress messages channel sequence numbers, so gap detection on the owner-to-holder channel is unchanged; only what the holder does with a progress frame at a full buffer differs.
- **Rate caps.** `policy.effects[Tag].progressEvery` (default 250 ms, from 50 ms to 1 minute) bounds each attempt. Each actor accepts at most 20 progress frames per second across all its effects at the owner (a token bucket with a burst of 20); excess is dropped and counted. Each runner's executor pool sends at most 2,000 progress messages per second in total; excess is coalesced in the slots and sent later. These are fixed in M2.18 except `progressEvery`.
- **Size caps.** An encoded frame is at most 4 KiB, below the 64 KiB inbound frame limit, so progress can never dominate a holder's buffer. With the per-actor rate cap, one actor's progress costs at most 80 KiB/s per connection before holder coalescing.

### 5. Durability: progress is not authoritative state

- No progress frame is ever read back by the framework as input to a turn, a route, a retry decision, a cancellation, or a recovery. An effect's outcome is decided only by its settle statement.
- Losing any number of frames, including all of them, changes no row, receipt, event, route, dead letter, or outcome.
- A client that must know how far work got after a disconnect must get it from committed state. An application that wants durable checkpoints has the executor return partial results through `onSuccess` of smaller effects, or runs the work as a workflow ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)) whose steps commit; progress frames are a display channel for the time between.
- After `Resync` (ADR 0023 §7) clients discard displayed progress for the actor and show committed state until new frames arrive; progress carries no event, so resync never replays it. Reconnecting starts with no progress history.
- A new invariant **C5** records this: progress frames never change durable state or effect outcomes, and their loss is visible as a `seq` gap rather than mistaken for continuity.

### 6. Authorization and tenancy

- Progress is delivered only within the performing actor's tenant and only to that actor's sessions. The `Progress` message's `ref` is checked against the activation; the holder delivers only to connections it holds for exactly that `(tenant, actor type, actor id, member)`, as for any frame (ADR 0023 §6 item 8).
- The holder forwards a progress frame only on authorization no older than `reauthorizeEvery`, like any frame, and on revocation discards buffered progress frames with the rest of the outbound buffer.
- `to: "performer"` compares principals as the `Caller` schema stores them, so progress from one user's import is not shown to other members of the same actor's connections by default. `to: "all"` is an explicit choice that every connection authorized for the member may see the effect's progress.
- Stream handlers decide their own audience because they run as the subscriber.
- Progress frames are classified like effect payloads and success values (the [data classification](../security/data-classification.md) of the effect's input): they are never logged. Telemetry records counts, drop reasons, and latency only.
- An executor cannot use progress to reach another actor, another tenant, or a client of its choosing: the message goes to the actor named by the effect row's owner, which the pool took from the row it claimed, never from executor code.

### 7. API and wire shape

- `Actor.effect(tag, { input?, success?, progress? })`; `ProgressOf(E)` is the frame type.
- `X.Executor.progress(E, frame): Effect<void>`.
- `Actor.connection(name, { ..., progress?: { effects, to?: "performer" | "all" } })`.
- `Actor.stream(name, { ..., progress?: { effects } })`.
- `X.Read.progress(E, { effectId? }): Stream<ProgressEntry(E)>` in stream handlers whose member lists `E` only.
- `policy.effects[Tag].progressEvery`.
- In-process `ActorTest` connections yield progress as `{ progress: { effect, effectId, attempt, seq, frame } }` beside `{ frame, cursor?, event? }`, `Resync`, and `ResyncReplayed`. `ActorTest` adds `test.dropProgress(predicate)` to drop progress messages between pool and owner.
- **WebSocket (ADR 0027).** This amends ADR 0027's statement that executor progress travels inside `frame` as a member frame: progress is not a member frame and does not use the `frame` message. A new server-to-client message `t: "progress"` with `effect`, `effectId`, `attempt`, `seq`, and `frame`, carrying no `cursor` or `event`. ADR 0027 already requires clients to ignore a `t` they don't know, so older clients are unaffected. SSE event feeds carry durable events only and get no progress.
- **TypeScript SDK.** A connection's frame stream yields progress envelopes typed by the member's `progress.effects`.

## Alternatives rejected

- **Progress as commands or events.** Durable, receipted, and replayable, which is exactly what transient progress must not be: a turn per tick on one hot actor, and history nobody wants to replay. Applications that need durable checkpoints already have commands and workflows.
- **Executors broadcast to holders directly.** The executor's runner would need the actor's connection list (which only the owner loads, fenced by generation), would open a second, unsequenced path to each holder, and would break ADR 0023's rule that every frame to a connection leaves through one activation's ordered channel, so gap detection and seals would no longer cover everything a client receives.
- **Give executors `X.Connection` or `broadcast`.** Executors run outside the actor and outside turns; a general broadcast capability would let executor code pick recipients and frames outside the actor's authorization model, and would be an out-of-turn broadcast, which ADR 0023 rules out.
- **Store the latest progress in a row for late joiners.** A write per tick on the owner's shard from a process with no database capability, or a new write path for the pool. Late joiners read committed state; the next tick arrives within `progressEvery`.
- **Exactly-once or reliable progress.** Retries, acknowledgments, and buffers for a display channel would cost more than the work they report and would re-create the durability this ADR avoids.
- **Close slow consumers on progress overflow.** A cosmetic channel would end sessions that carry durable-backed frames; dropping progress and keeping the session is the better failure.
- **Let `progress` fail or die on bad input.** A defect would make the effect's outcome unknown and dead-letter it as ambiguous for a display bug.
- **Deliver progress to every connection of the actor by default.** It would leak one principal's work to others sharing the actor; the default is the performer.

## Consequences

- Long effects can show live progress with no transaction, receipt, or state write per tick, and without a side channel outside the actor's authorization.
- Progress adds a second kind of live output with weaker guarantees than member frames. Clients must treat it as display-only, keep the highest `(attempt, seq)`, and reset on `Resync` or reconnect.
- An actor type that opts in may be woken, and kept resident, by its effects' progress while they run. Actor types that do not opt in pay nothing: the pool sends no messages for them.
- The owner does one indexed single-row read per effect id per activation that receives progress. Turn statement counts do not change; the Statements gate baselines stay as they are.
- Retries restart `seq` at 1 under a higher `attempt`; clients that show a percentage may see it go backwards on a retry, which is true.

## Behaviour changes against existing contracts

Each change is made in this ADR's pull request as a labelled target, except where the row says it amends an accepted ADR, which stays unedited as the decisions index requires.

| Document                                                                                                                                                                                                                                              | Was                                                                                                       | Becomes                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [07 realtime](../contracts/07-realtime.md)                                                                                                                                                                                                            | only committed state publishes; single frames and stream elements are never dropped or coalesced          | Labelled exception: executor progress frames are pre-commit, best-effort, may be coalesced or dropped with a visible `seq` gap, never close a session, and never state or events.  |
| 07 realtime; amends ADR 0023 §9                                                                                                                                                                                                                       | every outbound frame counts toward the 1,024-frame / 1 MiB buffer and overflow closes with `SlowConsumer` | Progress frames are coalesced per effect in the buffer, dropped rather than admitted past the limits, and never cause `SlowConsumer`.                                              |
| [08 background work](../contracts/08-background-work.md)                                                                                                                                                                                              | executors report only by returning a value                                                                | Executors may also report progress through `X.Executor.progress`; progress never changes the effect's outcome.                                                                     |
| [Server API](../api/01-server-api.md), [context](../api/02-context.md)                                                                                                                                                                                | `Actor.effect({ input?, success? })`; `X.Executor` has `effectId`, `attempt`, `principal`, `ref`          | `progress` schema on `Actor.effect`, `X.Executor.progress(E, frame)`, `Actor.connection({ progress })`, `X.Read.progress` in stream handlers, `policy.effects[Tag].progressEvery`. |
| [TypeScript SDK](../api/03-typescript-sdk.md); amends ADR 0027 §WebSocket                                                                                                                                                                             | server messages are `open`, `frame`, control frames, `reauthenticate*`, `end`                             | Adds `t: "progress"` with `effect`, `effectId`, `attempt`, `seq`, `frame`; no cursor.                                                                                              |
| [Invariants](../verification/invariants.md), [failure matrix](../verification/02-failure-matrix.md), [conformance](../verification/01-conformance.md), [support matrix](../operations/support-matrix.md), [threat model](../security/threat-model.md) | no progress evidence                                                                                      | Invariant **C5**, the rows and cases below, a target support row, and a threat row for progress disclosure and flooding.                                                           |

## Verification required of M2.18 (`conformance/progress.ts`)

Cases run on real Postgres with the in-process multi-runner harness and `Transport.inProcess`; single-runner cases also run on PGlite under the same names.

- `delivers progress from an executor on runner C to a connection parked at holder A for an actor owned by runner B` — the activation is parked when the first frame arrives and wakes on it.
- `loses nothing durable when every progress message is dropped` — `test.dropProgress(() => true)`: the effect routes `onSuccess` once, receipts, state, events, and outbox rows equal a run without progress.
- `keeps reporting across a retry` — attempt 1 reports and fails retryably; attempt 2's frames reach the client with `attempt = 2` from `seq` 1.
- `discards old-generation progress on owner move` — owner A forwards progress to a paused client's holder and dies; owner B commits the route without forwarding progress to that holder; on resume the client sees `Resync` and the route frame and no progress from A.
- `stops progress at renewal after cancellation` — cancel commits while ownership moves and the new activation holds a cached open check; the pool's next renewal closes the slot and no progress follows it.
- `drops delayed progress after a route-less settle` — an effect with no `onSuccess` settles and deletes its row; a delayed frame is dropped after `ProgressClosed`, and within 5 seconds when `ProgressClosed` is dropped.
- `delivers performer progress after a cold wake` — two callers' connections on a parked actor; progress wakes it and reaches only the performer's connection.
- `drops progress that arrives after the route commits` — frames delayed past the settle, on the same activation and after an owner move between settle and delivery: none reach the client after the route's broadcast.
- `drops progress after the cancelling commit` (with ADR 0024) — a running effect cancelled on another runner: no frame after the cancel turn's broadcast, `onCancelled` reported once.
- `delivers no progress to a connection whose caller is not the performer`, and `delivers to every authorized connection with to: "all"`.
- `delivers no progress to a connection after revocation` — `authorize` starts denying; buffered progress is discarded and nothing more arrives.
- `never delivers progress to another tenant's connection with equal actor ids`.
- `keeps seq increasing per attempt and never delivers a lower attempt after a higher one on one activation` — runner killed mid-effect; attempt 2 starts at `seq` 1.
- `drops progress past its attempt's lease` — a partitioned executor runner keeps sending after its lease; the owner drops frames past `leaseUntil`.
- `coalesces progress at progressEvery and at the holder, and never closes a slow consumer because of progress` — a client that stops reading; member frames still close it with `SlowConsumer` at the limits, progress alone never does.
- `drops oversized, undecodable, and mismatched frames with a warning and leaves the outcome unchanged`.
- `is a no-op when a captured progress runs after its attempt`.
- `caps accepted progress per actor and per runner` — the counters report drops; unrelated actors' turns keep their latency.
- `sends nothing for actor types that do not opt in` — no `Progress` messages leave the pool, and no parked actor wakes.
- `streams progress to an Actor.stream handler through read.progress and drops the oldest when its buffer is full`.
- `keeps turn statement counts unchanged` — the Statements gate over `benchmarks/baselines/statements.json`.
- `filters stream progress by effect input` — two concurrent `Transcode` effects on one actor; an `Encoding` stream filtering on `p.effect.assetId` sees only its asset's frames.
- `bounds effect checks` — at most one effect check per effect id per 5 seconds per activation, by statement count over a 30-second reporting effect.
- `discards buffered progress at the route` — a paused client with buffered progress resumes after the route commits and receives the route's frame and no progress for the effect; the same for cancellation and a route-less settle.
- `evicts progress before member frames overflow` — buffered progress plus member frames never exceed 1,024 frames or 1 MiB, and the session closes with `SlowConsumer` only when member frames alone exceed them.
- `sends nothing for a stream that does not list the effect` — an actor with only a `read.follow` stream stays parked while its effect reports.
- Declaration tests: `progress` for an undeclared or progress-less effect does not compile; a connection member listing an effect without `progress` is rejected at `Actor.make`; `read.progress` outside a stream handler does not compile.
- M3.3: `delivers executor progress to a WebSocket client as t: "progress"`, and an older client ignores it.

## Failure-matrix rows

| Fault point                                         | Required result                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Progress message lost between executor and owner    | Nothing durable changes; the effect's outcome and route are unchanged; the client sees a `seq` gap and later frames.                                                                                                                                    |
| Executor runner dies while reporting progress       | Frames stop; the next attempt reports under `attempt + 1` from `seq` 1; the activation drops the dead attempt's late frames once the new attempt's arrive or its lease passes.                                                                          |
| Owner dies with progress in flight                  | Frames in flight are lost; holders resync as ADR 0023 requires; the pool's next frames reach the new owner, which runs the effect check before delivering.                                                                                              |
| Progress arrives after the effect settled           | Dropped by the activation that committed the route, or by the effect check on a new activation; no progress follows the route's broadcast. Without a route, `ProgressClosed` closes the effect; if it is lost, delayed progress stops within 5 seconds. |
| Progress arrives after the effect was cancelled     | Dropped; `onCancelled` (or its fallback) reports once.                                                                                                                                                                                                  |
| Progress floods a slow client                       | Coalesced per effect at the holder, dropped or evicted by member frames at the buffer limits, and discarded at `ProgressEnd`; the session is never closed because of progress.                                                                          |
| Effect check cannot reach the database              | The frame is dropped and the check retried after 1 second; no turn fails and no session closes.                                                                                                                                                         |
| Executor sends an invalid or oversized frame        | Dropped with a warning and counted; the attempt's outcome is unchanged.                                                                                                                                                                                 |
| Connection loses authorization with progress queued | Buffered progress is discarded with the rest of the outbound buffer; nothing more is forwarded.                                                                                                                                                         |

## Benchmark plan (`progress`, M2.18)

This ADR is documentation only; there is nothing to measure until M2.18. M2.18 adds `tooling/benchmarks/src/scenarios/progress.ts` and commits its results under `benchmarks/results/`:

- **Environment.** Real Postgres 18.6 in Docker on one host, three in-process runners (executor, owner, and holder on different runners), `Transport.inProcess`, Bun 1.4.2; the result JSON records CPU, memory, and commit.
- **Workloads.** (a) 1,000 actors, each with one effect reporting every 50 ms for 30 s to one connection; (b) one actor with 100 concurrent effects and 1,000 connections under `to: "all"`; (c) 1,000 effects on an actor type that does not opt in, as the zero-cost control; (d) workload (a) with the connection's client paused.
- **Measures.** `exec.progress` call cost (p50/p95/p99, must not suspend); executor-to-client latency p50/p95/p99; frames delivered versus sent and drop counts by reason; effect-check reads per activation; turn latency of unrelated turns on the owner with and without progress (must be within noise); holder memory per connection in (d); messages sent in (c), which must be zero.
- **Repeats.** Five runs per workload after one warm-up; report the median of each percentile and the coefficient of variation, and treat a difference under 2 × CoV as noise.
- **Statements gate.** Turn statement counts in `benchmarks/baselines/statements.json` must not change. Any change is explained in the M2.18 PR.

## Decided questions

Dallen accepted every proposed default on 2026-09-28.

**Q1. API spelling.** `exec.progress(Transcode, frame)` with the class as a type witness. `Transcode.progress(frame)`, a static on the effect class that reads the running `X.Executor`, was rejected because it hides the dependency on the executor context.

**Q2. Default audience.** `to: "performer"`. `"all"` stays an explicit choice; as the default it would be a disclosure risk on shared actors.

**Q3. Does accepted progress keep an actor resident?** Yes, it counts as activity, so a reporting effect does not wake the actor on every tick after `hibernateAfter`.

**Q4. Rate and size defaults.** `progressEvery` 250 ms (50 ms to 1 minute), 20 frames/s per actor, 2,000 messages/s per runner pool, 4 KiB per frame.

**Q5. Effect check.** One indexed single-row `actor_outbox` read per effect id per activation, to keep "no progress after the route" true across owner moves. Skipping it and accepting a stale-frame window after the route was rejected.

**Q6. Progress to workflows and other actors.** Out of scope; only the owner's own connections and streams. A workflow step or another actor that needs progress reads committed state or uses a cross-actor subscription on committed events.

**Q7. Late joiners.** No latest-value cache; a new connection sees progress from the next frame. An in-memory last frame per open effect, sent on `open`, can be added later without changing semantics.

## Revisit conditions

Revisit when measured progress traffic affects unrelated turn latency, when applications need progress outside the owner's sessions (workflows, handles, other actors), when late joiners need the last value, or when hosted ingress (ADR 0031) moves holders out of runners.
