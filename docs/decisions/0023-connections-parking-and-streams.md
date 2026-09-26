# ADR 0023: Connections, parking, and streams

**Status:** accepted (2026-09-26, Dallen; proposed 2026-09-26)

## Context

[Realtime continuity](../contracts/07-realtime.md) promises `Actor.connection` sessions whose sockets stay open while the activation hibernates (`policy.connections: "park"`), per-connection state of up to 16 KiB in `actor_connections`, a `resumed` flag, best-effort `broadcast`, a live `Actor.stream` that ends with its activation, and a "documented revocation bound" for live and parked sessions. None of it is implemented, and the contract leaves the mechanism open:

- Nothing says which process holds a socket. The activation cannot hold it, because parking means the activation goes away while the socket stays open.
- The research sketches ([`research/v4/DX.md`](../../research/v4/DX.md) decisions 126 and 163) implement a connection as one long-lived `Stream` running on the activation. A running fiber cannot survive hibernation, so that shape cannot park.
- Today an activation is the command entity registered with `concurrency: 1` and `mailboxCapacity`, and it acquires its generation lazily in its first command turn. Frames sent to that entity would queue behind commands, count against `mailboxCapacity`, and deadlock a frame handler that calls its own actor.
- With several runners (M2), the socket can be on one runner while the actor's owner is on another, and either can die without the other.
- The revocation bound is referenced by contracts 07 and 10, [ADR 0004](0004-receipt-access-revocation-and-expiry.md), invariant H2, the ledger, and the failure matrix, but no number or mechanism exists.
- "Slow consumers require explicit resync or disconnect" has no rule for what a slow consumer is or what the client sees.

M2.10 builds connections, parking, and streams on an in-process transport against the M2.1 multi-runner harness. M3.3 adds WebSocket and SSE, and M3.1 (ADR 0027) defines the wire format. This ADR fixes everything those slices need except the wire format, so M3 adds a transport without redesigning sessions.

## Decision

### 1. A transport holds sockets; activations never do

Each runtime runs one **transport** for its whole lifetime. The runner whose transport accepted a socket is the connection's **holder**. The holder keeps the physical socket, the connection's verified caller, its reauthorization timer, its inbound and outbound buffers, and nothing else. It does not run connection handlers and does not keep connection session state.

- Embedded runtimes get `Transport.inProcess`, exported from `durable-actors/runtime` and used by `ActorTest`. It behaves like a network transport: frames are schema-encoded, cross the same holder-to-owner path as a real socket, and can be dropped or delayed by the test. `ActorTest` adds `test.connect(ref, Member, params, { holder? })`, which returns `{ connectionId, send, frames, close }` (`frames` is a `Stream` of server frames that fails with the session's end) and lets a harness test pick the holder runner, and `test.hibernate(ref)`, which ends the activation as `hibernateAfter` would.
- M3.3 adds a WebSocket transport, and SSE for event feeds, behind the same interface. The holder is whichever runner the client's socket reached; the framework never requires the socket to land on the actor's owner.
- A holder identity is `(runner address, holder epoch)`. The epoch is a UUIDv7 minted each time a transport starts, so a restarted runner at the same address is a different holder.

### 2. Connection members and handlers

A connection is declared in the contract like any other member. Its handler is a set of short callbacks, not a long-lived stream, because a callback can run on whichever activation is current when the next frame arrives.

```ts
// chat/contract.ts
export class Typing extends Schema.TaggedClass<Typing>()("Typing", { user: Schema.String }) {}

export const Live = Actor.connection("Live", {
  params: { since: Schema.optional(Schema.String) }, // opening input, validated like command input
  server: Schema.Union([MessageAdded, Typing]), // frames the actor sends
  client: Typing, // frames the client sends
  session: { typingSince: Schema.optionalKey(Schema.DateTimeUtc) }, // at most 16 KiB encoded
  errors: [NotAMember, UnknownCursor, RetentionGap], // declared failures of `open`
})

export const Chat = Actor.make("Chat", {
  key: RoomId,
  events: [MessageAdded],
  api: { SendMessage, Recent, Live, Transcript },
  policy: { connections: "park", reauthorizeEvery: "60 seconds" },
})
```

```ts
// chat/layer.ts
export const ChatLive = Chat.toLayer(
  Effect.gen(function* () {
    const access = yield* RoomAccess
    return {
      SendMessage: Effect.fn(function* ({ body }) {
        const turn = yield* Chat.Turn
        const message = new MessageAdded({ id: turn.commandId, body })
        yield* turn.emit(message)
        yield* turn.broadcast(Live, message) // flushed only after COMMIT
      }),
      Live: {
        open: Effect.fn(function* ({ since }) {
          const conn = yield* Chat.Connection
          yield* access.requireMember(conn.caller, conn.ref) // NotAMember rejects the open
          for (const entry of yield* conn.events(MessageAdded, { after: since }))
            yield* conn.send(entry.event)
        }),
        frame: Effect.fn(function* (typing) {
          const conn = yield* Chat.Connection
          yield* conn.session.set({ typingSince: yield* DateTime.now })
          yield* conn.broadcast(typing, { except: conn.connectionId })
        }),
        close: Effect.fn(function* () {
          const conn = yield* Chat.Connection
          const user = Option.match(conn.principal, {
            onNone: () => "anonymous",
            onSome: (p) => p.subject,
          })
          yield* conn.broadcast(new Typing({ user }), { except: conn.connectionId })
        }),
      },
    }
  }),
)
```

- `open(params)` runs once per connection; a declared failure rejects the connection, and nothing is stored. `resync({ after })` is optional and runs after an ungraceful owner death (section 7). `frame(frame)` runs for each inbound frame. `close(reason)` is optional and best-effort (section 7).
- `X.Connection` provides the `X.Read` capabilities (`id` and `ref` of the actor, `caller`, `principal`, committed actor `state`, `cursor`, read-only `rows`, `group`, `blob`, `events`) plus `connectionId`, `member`, `resumed`, `session` (this connection's own state, with `get` and `set`), `send(frame)` to this connection, `broadcast(frame, { except?, to? })` to this member's connections, `connections()` to list this member's open connections as `{ connectionId, caller, session }`, and `close(reason?)`. Actor state is `conn.state`, as in every read context; connection state is always `conn.session`.
- `X.Turn.broadcast` takes the member: `turn.broadcast(Live, frame, { except?, to? })`. `turn.connections(Live)` lists that member's open connections, paged like `conn.connections()`, so a turn can target a broadcast. Frames are queued and flushed after COMMIT, and discarded on rollback or declared failure, as today.
- Connection handlers never write actor state, rows, events, or blobs. A frame that must change durable data calls a command through a handle: `yield* (yield* Chat.get(conn.id)).SendMessage({ body })`. `X.get` is available in connection handlers because they are not turns.
- Every connection handler runs with `Tenant` set to the actor ref's tenant and `CurrentCaller` set to the caller the owner stored for that connection at open. The caller never comes from frame content. The build Effect runs with a `System` caller whose `source` is `"actor"`, never with the waking connection's caller, so a handle acquired during build does not carry a connection's identity. Commands called from handlers are external admissions: each call passes `authorize` and command-identity checks.
- Commands called from a connection handler get command ids that are stable across redelivery but unguessable (section 12), so a redelivered frame replays their receipts instead of executing them again.
- Handlers for one connection run one at a time, in frame order. Handlers for different connections run concurrently. None of them pass through the command mailbox (section 4), so typing indicators never queue behind commands, and a frame handler may call its own actor. They read the state the activation last committed.
- `resumed` is `false` in `open` and in every later handler of an activation that ran that `open`. It is `true` in any handler that runs on an activation that did not see the `open`: after hibernation, after the actor moved to another runner, or after a restart.
- Connection and stream members break two rules in [server API](../api/01-server-api.md) that hold for every other member: a connection's `X.toLayer` entry is an object of handlers rather than one Effect function, and a stream's handler returns a `Stream`.

### 3. `actor_connections` (migration `0014_connections`)

```sql
CREATE TABLE actor_connections (
  routing_key bigint NOT NULL,
  connection_id text NOT NULL, -- UUIDv7 minted by the holder
  bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
  tenant_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  member text NOT NULL, -- the Actor.connection tag
  holder text NOT NULL, -- runner address of the socket holder
  holder_epoch text NOT NULL, -- minted when that transport started
  caller text NOT NULL, -- verified attribution, never credentials
  session bytea, -- codec version 1 (zstd); null when the member declares no session
  frame_seq bigint NOT NULL DEFAULT 0, -- last inbound frame whose session write committed
  opened_at_ms bigint NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, connection_id),
  FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
);
CREATE INDEX actor_connections_holder ON actor_connections (bucket, holder, holder_epoch);
```

- **Scope.** Every row carries `routing_key`, `tenant_id`, actor type, and actor id, and every statement except the sweep, the holder's shutdown batches, and the holder's liveness check filters on all four, like `actor_events`. Those three are framework maintenance, run per bucket under a framework role that optional RLS exempts ([contract 10](../contracts/10-security.md)). A connection id from a client is input, never authority: the holder resolves it to its own record and never looks a row up by id alone.
- **Contents.** `caller` stores only the `Caller` schema, never credentials or assertions. A session must not hold credentials; params, frames, and sessions are classified like command payloads.
- **Session limit.** 16,384 bytes of the schema-encoded JSON before compression, the same measure as `maxStateBytes`. A `session.set` above it is a deterministic defect of that handler (section 4).
- **Writers.** Only the statements in the table below write the table, each with its fence.
- A session update that matches no row because the row was deleted closes the connection with `SessionEnded { cause: "ServerClosed" }`; it is not retried.
- **Cleanup.** Rows never outlive their holder by more than one sweep (section 7). There is no retention setting: a closed connection leaves no row.
- **Neki.** Every statement is single-shard on `routing_key` except the sweep, holder-shutdown batches, and liveness checks, which every runner runs over all 256 buckets with one probe per bucket on `(bucket, holder, holder_epoch)`, like ADR 0021's relay scan, so no statement scans the fleet. Their deletes are fenced on epoch equality and idempotent, so several runners sweeping at once is harmless.

| Writer                                                              | Statement                                  | Fence                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Owner, after `open`                                                 | insert the row                             | runs in the open transaction, after the generation fence                                         |
| Owner, after a handler changed `session`                            | update `session` and `frame_seq`           | the activation's generation and `frame_seq < $seq` (section 4)                                   |
| Owner, when a holder reports an unknown connection or another epoch | delete those rows                          | full actor scope, `holder_epoch = $reported`, and the activation's generation                    |
| Owner, terminating turn                                             | delete all the actor's rows                | the turn itself                                                                                  |
| Owner, excluding an unresponsive holder                             | delete that holder's rows for this actor   | full actor scope, `holder = $address AND holder_epoch = $epoch`, and the activation's generation |
| Holder, on close                                                    | delete that row                            | full actor scope, `connection_id`, `holder = $address AND holder_epoch = $epoch`                 |
| Holder, on graceful shutdown                                        | delete its own rows in per-bucket batches  | `bucket`, `holder = $address AND holder_epoch = $epoch`, framework role                          |
| Bucket sweep                                                        | delete rows whose holder epoch is not live | `bucket` and `holder_epoch` equality, so a live epoch's rows are never touched; framework role   |

### 4. Opening, frames, and waking across runners

**Activation.** The runtime, not a Cluster entity, owns an actor's activation on its runner: the build Effect's scope, activation-local values, the cached generation and state, the list of open connections, and the idle timer. Two framework entities per actor type share it, with the same entity id and shard group so Cluster places them on the same runner:

- the command entity, unchanged (`concurrency: 1`, `mailboxCapacity`);
- a connection entity with unbounded concurrency and no mailbox capacity, which carries open, frame, close, resync, and stream messages. The holder's in-flight window bounds it instead.

Commands, connection messages, and open stream subscriptions all reset the one idle timer, and the activation ends only when both entities are idle. The activation has one generation: whichever of a command turn, an open, or a connection handler runs first on a new activation acquires it in a short framework transaction (`UPDATE actor_generations SET generation = generation + 1 ... RETURNING`), exactly as a command turn does today. Every connection-state write is fenced by that generation.

1. **Open.** The holder authorizes the caller with the runtime's `authorize` hook, using the member tag as `command`, before anything wakes. It sends `open` to the connection entity, which Cluster routes to the owner and which starts the activation if it is parked. The owner:
   1. checks `createdBy` from the generation row, failing `NotCreated` without running `open`;
   2. adds the connection to its connection list as _pending_: broadcasts to it are queued behind `open`'s own sends rather than skipped;
   3. runs `open` outside any transaction, holding the frames it sends;
   4. on success, runs one short framework transaction: the generation fence (acquiring one if this activation has none), then the row insert with the session `open` set;
   5. after commit, flushes `open`'s frames and then the queued broadcasts, marks the connection open, and acknowledges the holder with the activation's flushed-through cursor after those frames (section 6), plus a `Begin` if this holder has none for this generation. The holder records that cursor as the connection's baseline, so every open connection has a proven cursor, and starts forwarding inbound frames.

   A declared failure or defect in `open`, or a failed commit, removes the pending entry, leaves no row, and sends nothing. If the owner dies after the open's commit but before the acknowledgment reaches the holder, the holder closes the connection with `SessionEnded { cause: "ActorUnavailable" }` after `deliveryTimeout` and deletes the row as its own close writer. Because the connection is on the list before `open` reads events, a turn that commits during `open` cannot be missed; the client may receive an event both in `open`'s replay and as a broadcast, and deduplicates on the frame envelope's `event` field (section 6).

2. **Frame.** The holder numbers each connection's inbound frames and sends them to the connection entity with the connection id and sequence number. If the activation is parked, the message wakes it, the build Effect runs, and the handler sees `resumed === true` and the stored session. The owner acknowledges a frame after its handler returns and its session write, if any, commits, and sends that acknowledgment on the ordered channel to the frame's holder after every frame the handler sent to that holder. A handler that sent frames to other holders first waits for their channel acknowledgments, under the same rule as `Begin`: 1 second, one retry, then that holder is excluded (section 6) and the wait ends. So an owner that dies before acknowledging a frame causes its redelivery, never a silent loss of what the handler sent.
3. **Order.** The owner handles only the next expected sequence number for each connection and answers any other with "resend from n". A new activation learns the expected number from the holder's first message, which carries the oldest unacknowledged sequence. In steady state the holder keeps up to 32 unacknowledged frames in flight per connection and stops reading the socket beyond that, so a slow actor slows its client rather than dropping frames. After any delivery failure it resends from the oldest unacknowledged frame, one frame at a time, until an acknowledgment arrives.
4. **Session write.** When a handler changed `session`, the owner writes it with one statement after the handler returns:
   `UPDATE actor_connections SET session = $session, frame_seq = $seq WHERE <actor scope> AND connection_id = $id AND frame_seq < $seq AND EXISTS (SELECT 1 FROM actor_generations WHERE <actor scope> AND generation = $g FOR SHARE)`.
   The generation predicate fences a stale owner, and `frame_seq` makes a redelivered frame a no-op for the session. A handler that did not change `session` writes nothing.
5. **Redelivery.** Frame handlers are at least once: a frame whose acknowledgment was lost is handled again. Its session write applies at most once, and commands it called replay their receipts through their deterministic ids.
6. **Delivery failure.** If the owner is moving or unavailable, the holder retries with backoff until `deliveryTimeout`, then closes the connection with `SessionEnded { cause: "ActorUnavailable" }`.
7. **Defects.** A defect in a connection handler, including a session above 16 KiB, writes nothing, is recorded in the handler's span, and closes that connection with `SessionEnded { cause: "Defect" }`. The activation stays resident, as for command defects.

### 5. Parking, `keepAwake`, and hibernation

- `policy.connections: "park"` (default): open connections do not count as activity. The activation hibernates after `hibernateAfter` like an actor with no connections; its scope closes, activation-local values are discarded, and the sockets stay open at their holders. The next open or inbound frame wakes it.
- `policy.connections: "keepAwake"`: an open connection counts as activity, so the idle timer does not run while any is open. It is a residency preference, not a guarantee. A shard move, runner shutdown, restart, or `maxResidentActors` eviction still ends the activation, and the next handler sees `resumed === true`. Handlers must therefore be written the same way under both policies.
- Every end of an activation other than process death flushes its pending broadcasts and seals its broadcast sequences (section 6) before the scope closes and before its shard is released: hibernation, graceful moves, retryable-defect restarts, `maxResidentActors` eviction, and `ActorTest.invalidate`. A user who can provoke a restart therefore cannot disconnect everyone on the actor. It never closes a connection and never runs `close`.

### 6. Broadcast, and waking a parked actor to broadcast

A broadcast MAY wake a parked actor. It does so through whatever made the actor broadcast: a broadcast is always requested by a committed turn or by a running connection handler, so the trigger that runs that code wakes the actor first. There is no out-of-turn broadcast from a handle or client; ephemeral data from outside the actor arrives as a connection frame, and anything else as a command. Framework-originated frames, such as executor progress (the M2.17 progress-frames ADR), are delivered to the owner's connection entity like a frame, wake the activation there, and are broadcast by it, so every frame to a connection leaves through one activation's ordered channel.

The triggers that can make a parked actor broadcast, and how each one wakes it:

| Trigger                                                                                                  | Path                                                                                            | Wakes a parked activation because |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| Command from a handle or client                                                                          | command entity, direct                                                                          | it is a turn on the actor's owner |
| Intent or timer                                                                                          | the relay delivers a direct command ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)) | same                              |
| Cron tick                                                                                                | a keyed self-timer delivered as a command                                                       | same                              |
| Effect route (`onSuccess`, `onDeadLetter`)                                                               | an intent keyed by the effect id                                                                | same                              |
| Cross-actor subscription event ([ADR 0026](https://github.com/Rika-Labs/durable-actors/issues/70), M3.7) | the source's committed event delivered as a System command to the subscriber                    | same; see the interface below     |
| Inbound frame or open on another connection                                                              | connection entity                                                                               | section 4                         |

So the design question is not how a broadcast wakes an actor but what a woken actor must do to reach sockets it has never seen. Its activation starts with an empty connection list, and its connections may be held by any runner:

1. For an actor type that declares connection members, a cold activation loads the members' rows, only `(connection_id, holder, holder_epoch)`, in the admission round trip of its first turn ([ADR 0020](0020-two-round-trip-turn-pipeline.md)'s group 1, beside the state read), as pipelined keyset pages of 1,000; a first open, frame, or resync request loads them in its own fenced transaction. The list cannot change behind the activation's back, because every open takes the generation fence and runs on this activation. If the load fails, the turn fails as a retryable defect and commits nothing, so no broadcast is lost. It then keeps the list current from its own opens and closes while it stays resident. A turn's broadcasts are flushed only after its commit, so a broadcast from the first turn of a woken activation reaches every connection that was open when the turn committed, parked or not, on any runner.
2. It groups the target connections by holder and sends each holder one message with the encoded frame and the connection ids, over one ordered channel per holder. Frames to connections held by the owner itself stay in process. Messages reach a holder through a **holder entity**, a framework entity whose id is the holder's `(address, epoch)` and which only that runner hosts (see Q9 for how).
3. **Begin.** Before an activation's first message of any kind to a holder (a turn's broadcast, a connection handler's `send` or `broadcast`, an open acknowledgment, or a `resync` replay), it sends that holder `Begin(generation, owner address, owner epoch)` and waits for the acknowledgment. For a turn, `Begin` goes to every holder in the loaded list as soon as the list is known, concurrently with the handler, and the turn waits for acknowledgments only before its commit group, counting the wait against `commandTimeout`; for a handler, before its first send. From then on the holder watches that owner's Cluster registration (section 7), so an owner that sends anything and then dies is always detected. A holder that does not acknowledge within 1 second is retried once; if it still does not answer it is excluded: the turn's transaction (or a fenced delete, for a handler) removes that holder's rows for this actor, the owner sends it a best-effort `Excluded` notice, and the holder otherwise closes those connections at its next liveness check (item 9). Begin costs one message per holder per generation. If the owner dies after Begin but before commit, the holder resyncs its connections although nothing was lost; that is conservative, not a loss.
4. **Sequence and cursor.** Each message carries `(actor, generation, seq, through)`. The sequence counts this activation's messages to this holder for this actor, from 1. `through` is the activation's **flushed-through cursor**: the highest commit cursor all of whose broadcasts to this holder were handed to this channel before this message. A turn's own frames therefore carry the previous value, and after a broadcasting turn (or turn batch) has sent its last frame to a holder, it sends a `Flushed(through)` marker that advances it. Frames from connection handlers and `conn.send` carry the value current when they are sent, never a cursor the handler read. `through` is a continuity watermark only; many frames share one value, and it never identifies an event. A frame sent from an event entry (`conn.send(entry)` or `turn.broadcast(Live, entry)` with an `EventEntry`, or the `event` option) also carries `event`, that event's own cursor, which is what clients deduplicate on. The holder keeps its state per actor, keyed by `(tenant, actor type, actor id)`: the owner's address and epoch, the last `(generation, seq)`, and the last `through` it received. Per connection, keyed by the holder-minted id, it keeps only the baseline from the open acknowledgment, which is the activation's flushed-through cursor after `open`'s frames and the queued broadcasts were flushed.
5. A holder that sees a gap in `seq` closes the affected connections with `SessionEnded { cause: "SlowConsumer", resync: true }`.
6. **Seal.** Every end of the activation other than process death sends each holder a _seal_ with the last sequence and flushed-through cursor, waits for its acknowledgment (retrying until the holder acknowledges, or until `deliveryTimeout`), and only then releases the shard. The wait is bounded by Cluster's entity-termination budget; running past it leaves the generation unsealed, which is safe because holders then resync. On the same runner (hibernation, defect restart, eviction, `invalidate`) the runtime does not let a new activation acquire its generation until the previous activation's end (flush, seals, exclusion delete) has finished. So a holder never sees a newer generation before an older generation's seal, except when that older owner died. A holder that has not acknowledged its seal after 1 second and one retry is excluded as in item 3, in a final fenced delete before release; the remaining wait up to the termination budget applies only to holders that are answering. A generation that ended without a seal may have lost frames; section 7 says what the holder does.
7. A holder that answers with a different epoch, or that no longer knows a connection, causes the owner to delete those rows. A terminating turn sends each holder a close for the actor's connections after commit, and they close with `SessionEnded { cause: "Terminated" }`.
8. A holder entity rejects any message whose target epoch is not its own. It delivers a frame only to the connections in `to` that it holds for exactly the message's `(tenant, actor type, actor id, member)`, and drops messages whose generation is lower than the highest it has seen for that actor. In the other direction, the owner runs a frame only when the connection's stored `(holder, holder_epoch)` equals the sender's.
9. **Liveness check.** Every `min(reauthorizeEvery, 10 seconds)`, the holder confirms that its connections' rows still name it, in one statement per bucket on `(bucket, holder, holder_epoch)` under the framework role, not one per actor. A missing row means the owner excluded it, and the connection closes with `SessionEnded { cause: "ServerClosed", resync: true }`. The owner answers a frame from a connection whose row is gone with the same close. If no liveness check has succeeded for 30 seconds (the holder cannot reach the database), the holder closes every connection it holds the same way. A partitioned holder therefore learns within 10 seconds, or 30 without a database, that it may have missed frames.

Broadcast remains best-effort, but its loss is never silent: loss inside one activation shows up as a gap, loss at an ungraceful owner death as an unsealed generation and a resync frame (section 7), and loss to an unreachable holder as an exclusion. Durable facts are events; a client that must not miss anything follows events.

**Interface with cross-actor subscriptions (ADR 0026, M3.7).** ADR 0026 must satisfy the requirements below; its author confirmed them on 2026-09-26 and will state them there. A receipt replay of a delivery turn never re-broadcasts, so a delivery broadcast lost at an owner death is recovered only through `Resync` and the subscriber's events. A delivery is an internal command turn delivered by the relay through the command entity, with a derived command id and caller `System({ source: "subscription", ref })`; the source's cursor is available to the handler as `delivery.cursor` for its payload, but the framework stamp is the subscriber's own cursor.

- A subscription delivery is an ordinary command turn on the subscriber, through the command entity. It therefore wakes a parked subscriber on its current owner, and its handler has `X.Turn`, including `turn.broadcast`.
- A broadcast from a delivery turn is stamped with the subscriber's own event cursor, not the source's. A client that must not miss a projected change follows the subscriber's events, or the subscriber emits one event per delivery that it wants clients to replay.
- A retention-gap delivery is a turn like any other, so the subscriber can broadcast its own resync hint to its connections.
- A delivery turn runs in the subscriber's tenant, which must equal the source's; ADR 0026 checks this at startup and again at each delivery. Its caller is `System({ source: "subscription", ref })`, never a connection's caller. Deliveries run at the relay's bounded concurrency.
- A delivery-turn broadcast exposes source event data to the subscriber's connections under the subscriber's authorization only. Handlers must filter with `to:` when not every connection may see it.

```ts
// Dashboard subscribes to Order events (API from ADR 0026, as proposed there)
RecordOrder: Effect.fn(function* ({ event }) {
  const turn = yield* Dashboard.Turn
  yield* turn.state.set({ orders: turn.state.orders + 1 })
  yield* turn.emit(new OrderCounted({ orderId: event.orderId }))
  const viewers = (yield* turn.connections(Live))
    .filter((c) => canSee(c.caller, event))
    .map((c) => c.connectionId)
  yield* turn.broadcast(Live, new OrderCounted({ orderId: event.orderId }), { to: viewers }) // parked sockets on any runner
})
```

### 7. When a process dies

- **The holder dies.** Its sockets drop; clients reconnect and open a new connection with a new id, fresh session, and `resumed === false`, then replay events from their cursor or get `RetentionGap`. No `close` handler runs. Every runner sweeps all 256 buckets every 60 seconds (there is no bucket ownership, [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)) and deletes rows whose `(holder, holder_epoch)` is not live: its runner's Cluster registration has expired, or its address answers with a different epoch. An unreachable holder whose registration is still live is never swept, within one sweep after the holder's registration expires. A holder that restarted at the same address has a new epoch, so the old epoch's rows are swept. The sweep runs every 60 seconds.
- **The owner dies ungracefully, the holder lives.** Sockets stay open and the holder resyncs each of the actor's connections in place (below). Frames retry (section 4) and reach the new owner after the old owner's shard lock expires.
- **The owner moves gracefully** (shard rebalancing, drain, `keepAwake` eviction, hibernation, defect restart). It seals its sequences, so sockets stay open with no resync. Frames retry and reach the new owner, which reads the last committed session and sees `resumed === true`.
- **Graceful shutdown of a holder.** It closes its sockets with `SessionEnded { cause: "HolderShutdown" }`, runs no `close` handlers, and deletes its rows in batches before exiting; the sweep catches the rest.
- **`close` is best-effort.** It runs when the client or the server closes the connection and both holder and owner are alive. Presence or accounting that must be right uses leases, commands, or the connection list, never `close` alone.

**Resync in place.** An unsealed generation means frames may have been lost between the dead owner's commit and its flush. The holder does not close the socket. It tells the client exactly where continuity was last proven and lets the client, or the actor, fill the gap.

1. **Detection.** From the `Begin` it received, the holder knows the runner address and epoch of each actor's current owner. It detects an ungraceful owner death at whichever comes first: that runner's Cluster registration expires, or a message arrives from a newer generation while the older one is unsealed. A parked, idle connection is therefore resynced within the owner's registration expiry, not at its next frame.
2. **The frame.** The holder appends one framework control frame to every affected connection's outbound buffer, after every frame of the dead generation already queued there and before any frame of the new generation. It is exempt from the buffer limits, so a full buffer never turns a resync into a close.

   ```ts
   class Resync extends Schema.TaggedClass<Resync>()("Resync", {
     after: Schema.optional(Schema.String), // exclusive event cursor through which live continuity is proven; absent under stampCursor: false
     reason: Schema.Literal("OwnerLost"),
     deadline: Schema.DateTimeUtc, // informational; the holder enforces it on its own clock
   }) {}
   class ResyncReplayed extends Schema.TaggedClass<ResyncReplayed>()("ResyncReplayed", {
     through: Schema.optional(Schema.String), // the member's resync handler replayed everything through this cursor
   }) {}
   class ResyncDone extends Schema.TaggedClass<ResyncDone>()("ResyncDone", {
     through: Schema.String, // client to server: resynchronized through this cursor
   }) {}
   ```

   Control frames travel in their own envelope variant, separate from member frames (ADR 0027 defines the wire encoding), so an application class tagged `Resync`, `ResyncReplayed`, or `ResyncDone` can never be taken for one; `Actor.connection` also rejects those tags in `server` and `client` at build. Member frames reach clients as `{ frame, cursor?, event? }`, where `cursor` is the frame's flushed-through watermark and `event` the cursor of the event the frame was sent from (both absent under `stampCursor: false`), and `frames` yields those envelopes plus `Resync` and `ResyncReplayed`. Only the holder creates `Resync` and `ResyncReplayed`: it drops any owner message carrying a control frame and never forwards one from a client.

3. **Cursor semantics.** `after` is the later of the dead generation's last `through` at this holder and the connection's open baseline. It is exclusive, like every event cursor, and a lower bound: every **event-backed** frame for an event at or before `after` was delivered; frames for later events may have been lost; it never says later events were lost. It covers event-backed frames only. A frame that carries no event (state-derived frames, typing indicators, subscription projections without their own event) may have been lost at any cursor, and a client that derives state from such frames MUST reload that state; a member whose frames all mirror events says so by replaying them in `resync`. The replay may also include events the client was excluded from with `except`; handlers that must not echo them filter by caller.
4. **Client obligations.** On `Resync` the client MUST treat live state derived from earlier frames as possibly incomplete, then resynchronize before relying on it again: replay events after `after` (through a query, a stream with `read.follow`, or the member's `resync` handler), deduplicating by the `event` field on each frame envelope (or an application id in the payload), and reload any state derived from frames that carry no event, or from everything when replay fails with `RetentionGap`. It then sends `ResyncDone { through }`. Frames the server sends after `Resync` are from the new generation; the client applies them after its resync, deduplicating by `event`. A client that does not implement `Resync` (a pre-M3.5 SDK) never sends `ResyncDone` and is closed at the deadline, which is the old behaviour.
5. **Server help.** A connection member may declare an optional `resync({ after })` handler. The holder asks the new owner to run it as soon as the actor is reachable, retrying like a frame until the owner answers `ResyncAccepted` (the request is queued) and then until `ResyncReplayed`, so a second owner death during the replay is detected through the new owner's `Begin` and resyncs again. The request carries `authorizedUntil` like a frame (section 8), and the owner refuses it past that point. It runs with `X.Connection` and `resumed === true`, before any further frame handler on that connection; frames that arrive meanwhile wait behind it. The owner runs at most 64 `resync` handlers at once per runner and 16 per actor, started with jitter, and queues the rest; handlers with the same `after` on one actor share one events read; frames it sends count against the connection's 1,024-frame and 1 MiB outbound limits, so an oversized replay ends in `SlowConsumer` rather than exhausting memory. When it returns, the holder sends the client `ResyncReplayed { through }`, with the flushed-through cursor after its frames. It usually replays events:

   ```ts
   Live: {
     open: /* as above */,
     frame: /* as above */,
     resync: Effect.fn(function* ({ after }) {
       const conn = yield* Chat.Connection
       for (const entry of yield* conn.events(MessageAdded, { after }))
         yield* conn.send(entry) // sent from an EventEntry, so the envelope carries `event` for dedupe
     }),
   }
   ```

   The handler may not call `session.set`, because it runs outside any frame sequence; doing so is a defect. `RetentionGap` or `UnknownCursor` from it closes the connection with `SessionEnded { cause: "OwnerLost", resync: true }`, and a defect closes it with `SessionEnded { cause: "Defect" }`.

6. **Timeout.** The connection closes with `SessionEnded { cause: "OwnerLost", resync: true }` if the holder has not received `ResyncDone` 30 seconds after the resync's server part ended, measured on the holder's monotonic clock. The server part ends at the `Resync` frame for a member without a `resync` handler, and at `ResyncReplayed` for one with it. A member with a `resync` handler also closes the connection that way if no `ResyncAccepted` arrives within `shardLockExpiration + deliveryTimeout` of the `Resync`, which covers the dead owner's lock and the new owner's wake, or if `ResyncReplayed` does not follow within 5 minutes of `ResyncAccepted`, which bounds a long queue. While a resync is pending, the holder's `after` for that connection does not advance, so a second ungraceful death during a resync sends a new `Resync` with the same `after` and restarts the timers. A third `Resync` for the same connection within 5 minutes closes it with `OwnerLost` and a jittered `retryAfter` instead, so a crash-looping owner cannot replay forever. Outbound buffer limits apply throughout, except to the control frames.
7. **Authorization during a resync.** The reauthorization timer and the bound run unchanged. If the bound and the deadline both fire, the bound wins and the session ends with `Unauthorized`, not `OwnerLost`. Revocation cancels a pending resync request and any running replay.
8. **Late frames and acknowledgments.** After `Resync`, the holder drops any message from the dead generation that arrives late. The holder consumes `ResyncDone`: it never forwards it to the owner or to handlers, ignores it when no resync is pending or when it arrives before `ResyncReplayed` for a member with a `resync` handler, never writes `through` into its cursor record, and counts it against the inbound frame limits. A `ResyncDone` whose `through` is before `after` is accepted: the client chose to resync from state.

### 8. Revocation bound and reauthorization

The revocation bound is the per-actor policy `reauthorizeEvery`, default **60 seconds**, allowed from 1 second to 1 hour. It applies to connections and streams, and it counts from the last successful check.

- For connections, the holder reauthorizes by calling the runtime's `authorize` hook with the connection's caller, actor ref, and member tag at least once every `reauthorizeEvery`. It runs the check on a timer even while the connection is parked and idle, so revocation never waits for traffic and never wakes the actor.
- For streams, the subscriber's runner authorizes before sending the subscription, and the owner checks again before running the handler. The owner, which runs the stream, then reauthorizes the subscriber the same way with the stream tag.
- Each call has a timeout of the smaller of 10 seconds and half the bound. The holder schedules each check at `lastSuccess + reauthorizeEvery − timeout` and retries a timeout or defect with jittered backoff. It closes the session unconditionally at `lastSuccess + reauthorizeEvery`, measured on its own monotonic clock (the owner's for streams); a check in flight at the deadline does not extend it. `ActorTest` drives that clock with `advance`. So the bound is never exceeded.
- A denial closes the session with `ActorError` reason `Unauthorized { code: "access_denied" }`. Reaching the deadline without a successful check closes it with `Unauthorized { code: "reauthorization_unavailable" }`, which is retryable by reconnecting.
- The hook receives a `kind` field: `"command"`, `"query"`, `"open"`, `"stream"`, or `"reauthorize"`. Hooks should deny kinds they don't know.
- Every open, frame, and resync request, resends included, carries `authorizedUntil = lastSuccess + reauthorizeEvery`. The holder re-checks it on every send and resend, and the owner does not run a handler for a message past `authorizedUntil` (allowing 1 second of clock skew between runners); it asks the holder to reauthorize instead. A parked session therefore cannot wake its actor on stale authorization, and a frame delayed by retries or an owner move cannot run on it either.
- On `Unauthorized`, the holder discards the connection's outbound buffer and its unacknowledged inbound frames without delivering them, and the owner drops queued broadcasts for it. `close` does not run for a session ended by `Unauthorized`.
- Reconnecting is a new open with a full authorization check. Replay through `events` inside a connection runs under that connection's authorization.
- Served transports (M3) also cap the bound at the credential's own expiry and add a reauthenticate frame; ADR 0027 defines it.
- Revocation stops access within the bound. It does not cancel commands the connection already sent, per [contract 10](../contracts/10-security.md).

### 9. Slow consumers, backpressure, and resource limits

Nothing live is dropped silently. When the framework cannot deliver in order, it ends the session and says why. All limits below are fixed in M2 (Q6).

- **Inbound frames and params** are at most 64 KiB encoded, rejected at decode before buffering; an oversized frame closes the connection with `SessionEnded { cause: "Defect" }`.
- **Connections per actor** are at most 10,000 open per member; a further `open` fails with `RunnerAtCapacity`.
- **Per holder**, all outbound buffers share a 256 MiB budget and at most 50,000 connections; an `open` past either fails `RunnerAtCapacity`, and a connection whose frame would exceed the budget closes with `SlowConsumer` as if its own buffer were full.
- **Reauthorization** runs at most 64 `authorize` calls at once per holder, with jitter.
- **Broadcast** loads only `(connection_id, holder, holder_epoch)`. `conn.connections()` is paged (at most 1,000 per page) and returns `session` only when asked.
- **Streams** are at most 256 subscriptions per actor. A subscription-pinned activation counts toward `maxResidentActors`, and eviction ends its subscriptions with `ActivationEnded`.
- An `open` for a never-seen actor creates its generation row, like a first command; applications that must not let clients create actors use `createdBy`.

- **Connections.** Each connection's outbound buffer at the holder holds up to 1,024 frames or 1 MiB of encoded frames. When a frame would exceed either, the holder closes the connection with `SessionEnded { cause: "SlowConsumer", resync: true }`. It never discards single frames or coalesces them.
- **Inbound.** The 32-frame in-flight window (section 4) pushes back on the client's socket.
- **Streams.** The owner sends stream elements to the subscriber through a 256-element window, counted at the owner. A full window suspends the handler's stream, which is pull-based. If the window stays full for 30 seconds, the subscription ends with `SessionEnded { cause: "SlowConsumer", resync: true }`.

### 10. `Actor.stream`

A stream is a read-only live feed that runs on the activation for as long as one subscriber reads it.

```ts
export const Transcript = Actor.stream("Transcript", {
  input: { after: Schema.optional(Schema.String) },
  output: MessageAdded,
  errors: [NotAMember, UnknownCursor, RetentionGap],
})

// in Chat.toLayer
Transcript: ({ after }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const read = yield* Chat.Read
      yield* access.requireMember(read.caller, read.ref)
      return read.follow(MessageAdded, { after }).pipe(Stream.map((entry) => entry.event))
    }),
  )
```

- **Path.** A subscription is a streaming request from the subscriber's runner to the connection entity on the owner. The owner runs the handler and sends elements back through the window in section 9. It does not use a holder, `actor_connections`, or the broadcast path.
- **Lifetime.** Each subscription runs its handler once, on the activation. An open subscription counts as activity, whatever `policy.connections` says, because a running stream cannot park. The subscription ends when the handler's stream ends, the subscriber stops, or the activation ends; the last reaches the subscriber as `SessionEnded { cause: "ActivationEnded" }`, which is retryable by subscribing again. A move of the actor ends the activation, so it ends every subscription the same way. A stream never resumes by itself and never replays anything it did not replay the first time.
- **`read.follow(Event, { after })`**, available only in stream handlers, replays the committed events after the exclusive cursor and then emits each event as its turn commits, with no gap and no repeat between replay and live. It fails with `UnknownCursor` and `RetentionGap` like `read.events`. It is how a stream offers durable continuity: a subscriber that reconnects passes the last cursor it saw.
- **Authorization.** A subscription is authorized when it starts and reauthorized by the owner every `reauthorizeEvery` (section 8).

### 11. Errors

`ActorError` gains one reason, `SessionEnded { cause, resync }`, for connections and streams. `cause` is one of `ClientClosed`, `ServerClosed`, `SlowConsumer`, `HolderShutdown`, `HolderLost`, `OwnerLost`, `ActivationEnded`, `ActorUnavailable`, `Defect`, or `Terminated`. `OwnerLost` now ends a session only when an in-place resync fails or times out (section 7). `resync` is true when frames may have been missed and the client must resynchronize from state or events. `isRetryable` is true for `SlowConsumer`, `HolderShutdown`, `HolderLost`, `OwnerLost`, `ActivationEnded`, and `ActorUnavailable`. Authorization failures keep using `Unauthorized`. `SessionEnded` appears only in the error channels of connection and stream members; commands, reducers, and queries never produce it.

### 12. Security

- **Runner trust.** Cluster's runner-to-runner RPC has no authentication of its own. Holder, connection-entity, and command-entity traffic between runners is trusted only over mTLS or an isolated private network, and a deployment that claims transport support must provide one. This is written into [contract 10](../contracts/10-security.md) and the [threat model](../security/threat-model.md).
- **Command ids from connection handlers.** At open, the holder mints a 256-bit `commandSecret` that is never stored, logged, or exposed to handlers. The holder stamps each frame once with `issuedAt` (its clock minus 1 second of skew allowance) and resends it unchanged. A call's id is `v1.<issuedAt>.<issuedAt + retryWindowMs>.<uuid>`, where `uuid` is the first 128 bits of HMAC-SHA256(`commandSecret`, seq ‖ call index ‖ target ref ‖ command tag) with the version-4 and variant bits set. So ids match the existing command-id format, stay stable across redelivery, and cannot be predicted from connection ids or sequence numbers; a caller who pre-mints an id cannot block or read another connection's commands. A redelivered frame whose call fails `CommandExpired` or `InvalidCommandId` closes the connection with `SessionEnded { cause: "Defect" }`.
- **Telemetry.** Connection handler spans are named `durable-actors.<Actor>/<Member>.open`, `.frame`, and `.close`, and carry the connection id but never frame, param, or session contents.
- **Cursor metadata.** Every delivered frame carries the actor's event cursor, so a connection can infer the actor's event rate, including events it may not read. The cursor is classified as visible metadata; members that must hide it set `stampCursor: false`, and `toLayer` rejects a `resync` handler for such a member at build. Under it, frames carry no `cursor` or `event`, the open baseline is not sent to the client, and `Resync` and `ResyncReplayed` omit `after` and `through`, so their clients always resync from state after an owner death.
- **Visibility.** `conn.connections()` shows every handler the callers and sessions of all connections on the member. Applications must treat that as they treat actor state: never send it to a client unfiltered.

## Behaviour changes against existing contracts

Each change is made in this ADR's pull request, in the document named, except where the row says it amends an accepted ADR, which stays unedited as the decisions index requires.

| Document                                                                                                                                                            | Was                                                                   | Becomes                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [07 realtime](../contracts/07-realtime.md), [vision 05](../vision/05-realtime.md)                                                                                   | "an inbound frame or broadcast wakes the activation"                  | A broadcast may wake a parked actor through the trigger that requests it: a command, intent, timer, cron tick, effect route, subscription event, open, or frame. The woken activation loads its connection rows and reaches parked connections on any runner through their holders. There is no out-of-turn broadcast.                                        |
| 07 realtime                                                                                                                                                         | parking preserves sockets across hibernation                          | Also across graceful and ungraceful owner loss. An ungraceful owner death keeps sockets open and sends an in-band `Resync` frame with the last proven cursor; the client resynchronizes and acknowledges within 30 s or the connection closes with `SessionEnded { cause: "OwnerLost", resync: true }`. Connection members gain an optional `resync` handler. |
| 07 realtime                                                                                                                                                         | `Actor.stream` "ends with the activation"                             | Also: an open subscription keeps the activation resident, and its end reaches the subscriber as `SessionEnded { cause: "ActivationEnded" }`.                                                                                                                                                                                                                  |
| 07 realtime, [10 security](../contracts/10-security.md), [authorization model](../security/authorization-model.md); amends ADR 0004's "documented revocation bound" | "a documented revocation bound"                                       | `policy.reauthorizeEvery`, default 60 s, counted from the last success, checked on a timer, failing closed.                                                                                                                                                                                                                                                   |
| Runtime `authorize` hook ([server API](../api/01-server-api.md))                                                                                                    | called for commands, queries, and receipt reads                       | Also called on open and then periodically for every open connection and stream, with the member tag as `command`. A hook that switches on command names must handle these tags; one that allows unknown names allows sessions.                                                                                                                                |
| 07 realtime                                                                                                                                                         | slow consumers need "explicit resync or disconnect"                   | Fixed limits (1,024 frames or 1 MiB per connection; a 256-element window and a 30 s stall per stream) that end the session with `SessionEnded { cause: "SlowConsumer", resync: true }`.                                                                                                                                                                       |
| [02 command turns](../contracts/02-command-turns.md), [03 transactions](../contracts/03-transactions.md), invariant A3                                              | "Off-turn contexts MUST NOT directly mutate durable actor data."      | Unchanged for actor data. `actor_connections` is session data with its own listed writers, each fenced (section 3).                                                                                                                                                                                                                                           |
| [09 recovery](../contracts/09-recovery.md)                                                                                                                          | hibernation preserves parked connections                              | Also: holder death closes sockets without `close`, and the sweep deletes their rows; ungraceful owner death resyncs the actor's connections in place.                                                                                                                                                                                                         |
| Activation lifecycle ([lifecycle](../architecture/02-lifecycle.md))                                                                                                 | the activation is the command entity                                  | The runtime owns the activation, shared by the command entity and a connection entity; the generation is acquired by whichever runs first.                                                                                                                                                                                                                    |
| `policy.connections: "keepAwake"` ([server API](../api/01-server-api.md))                                                                                           | keeps the activation resident                                         | A residency preference only; shard moves, shutdown, restarts, and eviction still end the activation, and handlers see `resumed === true`.                                                                                                                                                                                                                     |
| [Context](../api/02-context.md); amends ADR 0010's `X.Connection` row                                                                                               | `X.Connection` is `X.Read` plus `id`, `state`, `resumed`, `broadcast` | `X.Read` plus `connectionId`, `member`, `session`, `resumed`, `send`, `broadcast` with options, `connections`, `close`; `conn.state` is actor state. `X.Turn.broadcast` takes the member. Stream handlers gain `read.follow`. `X.get` works in connection handlers, with deterministic command ids.                                                           |
| [Server API](../api/01-server-api.md)                                                                                                                               | every `X.toLayer` entry is one Effect function of its input           | A connection's entry is `{ open, frame, close?, resync? }`; a stream's handler returns a `Stream`. The member option `state` becomes `session`, and members gain `stampCursor`.                                                                                                                                                                               |
| Opening a connection                                                                                                                                                | not specified                                                         | Checks `createdBy` first, takes the generation fence, and can create the actor's generation row.                                                                                                                                                                                                                                                              |
| [10 security](../contracts/10-security.md), [threat model](../security/threat-model.md)                                                                             | runner-to-runner trust unstated                                       | Runner traffic is trusted only over mTLS or an isolated network; connection sweeps, shutdown batches, and holder liveness checks run under a framework role exempt from optional RLS; `Unauthorized` gains `reauthorization_unavailable`; the `authorize` hook gains `kind`.                                                                                  |
| [Error model](../contracts/error-model.md)                                                                                                                          | eleven `ActorError` reasons                                           | Adds `SessionEnded`, only on connection and stream members.                                                                                                                                                                                                                                                                                                   |

## Open questions and recommended defaults

Dallen accepted this ADR on 2026-09-26. He accepted every default except Q3 and Q10, which he decided differently; both are recorded below and built into sections 6 and 7.

**Q1. Handler shape: callbacks or one long-lived stream?** Default: callbacks (`open`, `frame`, `close`), as in section 2. A single stream (research decision 126) reads better for simple feeds but cannot park, so every connection would behave like `keepAwake`. A feed that needs no inbound frames is an `Actor.stream`.

```ts
// rejected shape: one fiber per connection, which pins the activation
Live: (params, inbound) => Stream.merge(feed(params), inbound.pipe(Stream.drain))
// default shape
Live: { open: (params) => replay(params), frame: (typing) => relay(typing) }
```

**Q2. May the framework write connection session state outside a turn?** Default: yes, as a fenced single-row write after the handler (section 4). The alternative routes every session change through an internal command and its receipt, which costs a full turn per typing indicator.

```ts
frame: Effect.fn(function* (cursor) {
  const conn = yield* Board.Connection
  yield* conn.session.set({ lastCursor: cursor.position }) // one UPDATE, no receipt, no turn
})
```

**Q3. Does a broadcast wake a parked activation?** **Decided (Dallen, 2026-09-26): a broadcast may wake a parked actor.** Every broadcast is requested by a turn or a connection handler, so the trigger that runs it (a command, intent, timer, cron tick, effect route, subscription event, or frame) wakes the actor through the ordinary turn or connection path, and the woken activation loads its connection list before flushing (section 6). There is no out-of-turn broadcast from a handle, which would need its own authorization, rate limits, and wake budget without adding a use the triggers above don't cover.

```ts
Effect.gen(function* () {
  const socket = yield* test.connect(room, Live, {}, { holder: "A" })
  yield* test.hibernate(room)
  const chat = yield* Chat.get(roomId) // owner is runner B
  yield* chat.SendMessage({ body: "hi" }) // wakes the actor on B; its broadcast reaches A
  const [frame] = yield* socket.frames.pipe(Stream.take(1), Stream.runCollect)
  expect(frame).toEqual(new MessageAdded({ id: frame.id, body: "hi" }))
})
```

**Q4. Revocation bound: value and scope.** Default: `policy.reauthorizeEvery`, 60 seconds, per actor type, range 1 second to 1 hour. A runtime-wide setting was considered; a per-actor policy lets a payments actor use 5 seconds without making every chat room pay for it.

```ts
Actor.make("Vault", { key: VaultId, api: { Watch }, policy: { reauthorizeEvery: "5 seconds" } })
```

**Q5. Does session state survive a reconnect?** Default: no. A reconnect is a new connection with a fresh session; the client passes what it needs, usually an event cursor, in `params`. A resume token would need its own ADR, because it must be audience-bound, short-lived, and fenced against the old socket.

```ts
Effect.gen(function* () {
  const socket = yield* test.connect(room, Live, { since: lastCursor }) // after any reconnect
})
```

**Q6. Slow-consumer limits.** Default: 1,024 frames or 1 MiB per connection, and a 256-element window with a 30-second stall per stream, not configurable in M2. Making them policies is cheap later; choosing them per actor before anyone has measured is not.

```ts
// M2: fixed. A later policy would look like this, and is not part of this ADR:
policy: {
  connections: "park" /* , outboundLimit: { frames: 4096, bytes: "4 MiB" } */
}
```

**Q7. Does an open stream keep the activation awake?** Default: yes (section 10). Otherwise every subscriber is cut off once per `hibernateAfter`.

```ts
Effect.gen(function* () {
  const feed = yield* chat.Transcript({ after: cursor }) // the activation stays resident while `feed` is read
})
```

**Q8. Does `close` run when the holder dies?** Default: no (section 7). Running it would need the owner to learn of the death, which only the sweep does, up to a minute later. Presence built on `close` alone would be wrong either way.

```ts
// presence that survives holder death: list open connections instead of counting closes
const online = Effect.map(conn.connections(), (all) => all.map((c) => c.caller))
```

**Q9. How does the owner reach a holder on another runner?** Default: a **holder entity** in a per-runner shard group. Each runner adds a shard group named after its address to its `shardGroups`, and registers one framework entity type in it whose id is its epoch. That is buildable on Cluster rc.116, whose `Runners` API only carries entity envelopes. Cluster requires every runner's `availableShardGroups` to name every group, so the runtime derives that list from runner registrations; the spike checks that a runner joining or leaving does not reshuffle other groups. M2.10 proves it in a spike as its entry gate: a message from runner B reaches runner A's holder entity, a message to a dead epoch fails, and a restart at the same address gets a new epoch. If the spike fails, M2.10 stops and this ADR is revised; no message is ever persisted for a broadcast.

```ts
Effect.gen(function* () {
  const holder = HolderEntity.client(yield* Sharding.Sharding)
  yield* holder(`${address}/${epoch}`).Deliver({ actor, generation, seq, frame, to: connectionIds })
})
```

**Q10. Ungraceful owner death: close or resync in place?** **Decided (Dallen, 2026-09-26): resync in place.** The holder keeps the socket open and sends the `Resync` control frame with the last proven cursor; the client resynchronizes and acknowledges within 30 seconds, optionally helped by the member's `resync` handler, or the connection closes with `OwnerLost` (section 7).

```ts
Effect.gen(function* () {
  const socket = yield* test.connect(room, Live, {}, { holder: "A" })
  yield* cluster.crashNext(room, "afterCommitBeforeFlush") // kills the owner's runner at that point
  yield* chat.SendMessage({ body: "lost?" }).pipe(Effect.ignore)
  const [resync] = yield* socket.frames.pipe(Stream.take(1), Stream.runCollect)
  expect(resync).toEqual(expect.objectContaining({ _tag: "Resync", after: lastCursorSeen }))
  // the member's resync handler replays MessageAdded after `after`; the lost message arrives
})
```

## Alternatives

- **Sockets on the owner only.** Proxy or redirect every socket to the actor's current owner. Rejected: a shard move would drop every socket of every moved actor, and M3 load balancers cannot route by actor.
- **Session state held by the holder.** Ship `session` with each frame instead of storing it. Rejected: a new owner could not list connections or their state, and contract 07 already requires `actor_connections`.
- **Wake on broadcast by storing broadcasts.** Rejected: it would make broadcast durable, which contract 07 rules out; durable output is events.
- **Frames through the command entity.** Rejected: its `concurrency: 1` mailbox would queue frames behind commands, count them against `mailboxCapacity`, and deadlock a frame handler that calls its own actor.
- **Drop the oldest frame on overflow.** Rejected: that is the silent loss contract 07 forbids.
- **Close sockets on an ungraceful owner death.** Rejected (Q10): every client of the actor would reconnect at once, although the in-place resync gives the same guarantee without a reconnect wave.
- **Out-of-turn broadcast from a handle.** Rejected (Q3): every realistic trigger already runs a turn, and a handle broadcast would need its own authorization kind, rate limit, and wake budget.

## Consequences

- A parked connection costs its holder a socket, buffers, and a timer, and costs the database one small row. The activation costs nothing until a frame arrives.
- A session-changing frame costs one database round trip; other frames cost none. The first handler on a new activation also acquires the generation.
- Reauthorization costs one `authorize` call per session per `reauthorizeEvery`, whether or not the session is active. At 10^4 connections and 60 seconds that is about 170 calls per second per deployment, which an application with an expensive hook must plan for.
- An ungraceful owner death makes every client of that actor resynchronize in place, usually by replaying a few events; it does not make them reconnect. Clients must implement `Resync` handling, which the Promise client (M3.5) does for connections whose member declares a `resync` handler.
- A cold activation of an actor type with connection members reads its connection rows in its first turn's admission round trip (one statement per 1,000 rows), and its first message to each holder waits for one `Begin` acknowledgment, overlapped with the handler for turns.
- Each holder runs one liveness statement per bucket every 10 seconds (at most 256 per 10 seconds per holder), independent of the connection count.
- Clients must handle `SessionEnded` and reconnect with a cursor. The Promise client (M3.5) does this for event feeds and surfaces it for connections.
- Streams hold their activation resident. A deployment with many idle subscribers should use connections instead.
- M2.10 depends on M2.1 for the harness. The sweep needs no bucket ownership.

## Evidence required

M2.10 puts its cases in `conformance/connections.ts` and runs them on PGlite and Postgres; cross-runner, crash, and contention cases run on the M2.1 harness against real Postgres. M3.3 puts its cases in `conformance/transports.ts`.

**M2.10 conformance cases:**

- `parks a connection when the activation hibernates and resumes the session on the next frame`: the session round-trips, `resumed` is true, and a `Ref` from the build is fresh.
- `keeps the activation resident under keepAwake and still resumes after a forced restart`
- `rejects an open with a declared failure and stores no row`
- `fails an open with NotCreated under createdBy without running open or storing a row`
- `misses no event committed while open replays` (a turn commits between `open`'s read and its commit; the client sees the event at least once).
- `lets a frame handler call its own actor's command without deadlock`
- `does not count frames against mailboxCapacity or queue them behind commands`
- `acquires a generation on the first frame after hibernation and fences a stale owner's session write` (Postgres, harness).
- `rejects a session above 16 KiB as a defect, closes the connection, and leaves the stored session unchanged`
- `applies a redelivered frame's session write once and replays its commands' receipts`
- `applies every frame once and in order when the owner moves with 32 frames in flight` (harness).
- `flushes turn broadcasts only after commit and discards them on declared failure or rollback`
- `delivers a broadcast from a command that woke the actor on runner B to a connection parked on runner A` (harness).
- `keeps sockets open across a graceful owner move and resumes on the new owner` (harness).
- `sends Resync with the last proven cursor when the owner is killed between commit and broadcast flush, and the resync handler delivers the lost event` (harness).
- `resyncs a parked, idle connection within the owner's registration expiry` (harness).
- `closes with OwnerLost when the client does not acknowledge Resync by its deadline` (harness).
- `drops late frames from the dead generation after Resync` (harness).
- `routes an executor progress frame through the owner activation, waking it` (M2.18).
- `closes with OwnerLost when the resync handler hits RetentionGap` (harness).
- `sends a second Resync with the same after cursor when the new owner also dies during a resync replay` (harness).
- `loses no event across an owner kill: every event after the client's last cursor arrives by resync or live frame` (harness, C4, randomized kill point).
- `delivers a broadcast from an intent, a timer, and an effect route that woke the actor on runner B to connections parked on runner A` (harness).
- `loads connection rows before the first broadcast of a woken activation, so a connection opened before hibernation receives it`
- `bounds concurrent resync handlers when an owner with 10,000 connections is killed, and all 10,000 connections finish their resync` (harness).
- `closes a connection with OwnerLost after a third Resync within 5 minutes` (harness).
- `gives every opened connection a baseline cursor from its open acknowledgment`
- `sends Begin before a woken frame handler's first send, and redelivers the frame when the owner dies before acknowledging it` (harness).
- `closes a connection with ActorUnavailable and deletes its row when the owner dies between the open's commit and its acknowledgment` (harness).
- `sweeps dead-epoch rows from every runner without bucket ownership` (harness).
- `does not let a same-runner activation acquire its generation before the previous one sealed` (harness).
- `closes an excluded holder's connections within 10 seconds, and every connection within 30 seconds when its liveness checks keep failing` (harness).
- `excludes a holder that does not acknowledge a handler's frame within 1 second and one retry, and acknowledges the inbound frame` (harness).
- `never sweeps a live-registered holder that is merely unreachable` (harness).
- `hides every cursor under stampCursor: false, and rejects a resync handler for such a member at build`
- `rejects session.set in a resync handler`
- `advances the flushed-through cursor only after a turn's last frame: owner killed after F1 of a turn that broadcast F1 and F2 resyncs from before that turn` (harness).
- `stamps a turn batch's frames with the previous flushed-through cursor` (harness, with P5 batches).
- `stamps a connection handler's broadcast with the flushed-through cursor, not the cursor it read, when it races a pending turn flush` (harness).
- `detects an owner that commits a broadcast and dies before its first message to a holder, through Begin` (harness).
- `excludes a holder that does not acknowledge Begin or the seal, and the holder closes those connections at its next liveness check` (harness).
- `sends no Resync after a graceful move, because the release waits for seal acknowledgments` (harness).
- `queues Resync behind the dead generation's buffered frames and exempts it from the buffer limit` (harness).
- `runs the resync handler before a frame that arrives during it, then sends ResyncReplayed` (harness).
- `starts the 30-second deadline at ResyncReplayed when the member declares a resync handler` (harness).
- `closes a client that never implements Resync at the deadline` (harness).
- `closes with Defect when the resync handler defects, and with SlowConsumer when its replay overflows the buffer` (harness).
- `ignores ResyncDone that arrives before ResyncReplayed`
- `tells the client to reload state after Resync for frames that carry no event` (C4, harness).
- `delivers a broadcast from a cron tick that woke the actor on runner B to a connection parked on runner A` (harness).
- `delivers a broadcast from a subscription delivery turn to connections parked on another runner` (M3.7, `conformance/subscriptions.ts`).
- `does not run resync past authorizedUntil, and cancels a pending resync on revocation` (harness).
- `ignores unsolicited or forged ResyncDone, rejects reserved control tags at build, and drops control frames sent by an owner`
- `marks replayed and live frames with the event's own cursor in event, so clients deduplicate, while cursor stays a watermark` (harness).
- `keys holder state by tenant: equal actor ids in two tenants on one holder, one owner killed, only that tenant resyncs` (harness).
- `never delivers a subscription broadcast to another tenant's connections with equal actor ids`
- `closes connections and deletes their rows within one sweep when the holder runner is killed` (harness).
- `sweeps the old epoch's rows when a holder restarts at the same address` (harness).
- `closes a connection with SlowConsumer and resync when its outbound buffer overflows`
- `closes a connection whose holder sees a gap in the owner's broadcast sequence`
- `disconnects a parked, idle session within reauthorizeEvery after authorize starts denying`
- `does not forward a frame on authorization older than reauthorizeEvery`
- `closes a session at the bound when the authorize hook hangs or keeps dying`
- `ends a stream with ActivationEnded when its activation stops, and keeps the activation resident while subscribed`
- `follows events from a cursor with no gap or repeat between replay and live`
- `ends a stream with SlowConsumer after its window stays full for 30 seconds`
- `closes every connection with Terminated and deletes its rows when the actor terminates`
- `scopes connection rows by tenant and actor` (equal actor ids and connection ids in two tenants).
- `runs a frame handler's X.get in the actor's tenant as the connection's caller, and gives handles built during build no connection caller`
- `drops buffered outbound frames and in-flight inbound frames on revocation and runs no close`
- `does not run a frame past its authorizedUntil after an owner move`
- `closes a session exactly at the bound while a check is still in flight`
- `lets no caller that pre-mints another connection's command id block or read its commands`
- `rejects a holder message for another epoch or another actor's connection`
- `rejects an inbound frame above 64 KiB and an open past the per-actor connection limit`
- `seals broadcasts on a retryable-defect restart so connections stay open`

**M3.3 transport cases:** contract 07's four transport tests (snapshot and live race, loss, replay, revocation) over WebSocket and SSE; a connection stays parked over a real socket; `Resync` and `ResyncDone` round-trip over WebSocket after a real owner-process kill; `Socket-owning process dies` with a real process kill; a reconnect wave after holder restart does not wake every actor at once.

**Failure-matrix rows.** Amended: "Parked connection wakes", "Socket-owning process dies", and "Live or parked session loses authorization". Added: "Owner runner dies ungracefully with open connections" (now a resync, not a close), "Client ignores Resync", "Trigger wakes a parked actor that broadcasts", "Owner moves with a full inbound window", "Frame redelivered after the owner restarts", "Session write from a stale generation", "Outbound buffer overflows or broadcast gap", "Connection session exceeds 16 KiB", "Holder restarts at the same address", "Actor terminates with open connections", "Frame delayed past its authorization", "Pre-minted command id from another caller", "Spoofed or misrouted holder message", and "Stream's activation ends".

**Ledger and invariants.** The **Connection park** gate is amended to match sections 5–7 and the Q3 default. Invariant C1 gains cross-runner evidence; A3 records the `actor_connections` writers; H2's session half names `reauthorizeEvery` and the discard of buffered frames. The threat model gains rows for stale session authorization, holder spoofing, predictable command ids, and session exhaustion. A new invariant C4 states that live output is never silently lost.

**Benchmark.** M2.10 adds the `connections` scenario: memory per parked connection at the holder, wake-on-frame latency after hibernation, session-write latency, reauthorization calls per second, and broadcast fan-out to 10^4 connections across two runners. M3.3 adds `ws` and `sse`, with reconnect waves.

## Revisit conditions

Revisit when a workload needs session state across reconnects (Q5), when measured reauthorization load is a problem at the 60-second default, when the holder-entity spike fails (Q9), when ungraceful owner deaths cause reconnect storms (Q10), or when hosted ingress (ADR 0031) moves holders out of runners into an edge tier.
