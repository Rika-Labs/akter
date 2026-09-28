# Context capabilities

**Responsibility:** define `Context` phases and capabilities.  
**Authority:** API contract.  
**Owner role:** API/runtime.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Handlers take only their input. Each phase provides one typed context object as an Effect service on the actor definition, so a capability used in the wrong phase is a missing-service type error. The runtime remains the final authority even when TypeScript prevents invalid use. See [ADR 0010](../decisions/0010-one-way-effect-native-api.md).

```ts
SendMessage: Effect.fn(function* ({ body }) {
  const turn = yield* Chat.Turn
  yield* access.requireMember(turn.caller, turn.ref)
  yield* turn
    .rows(messages)
    .insert({ id: turn.commandId, author_id: turn.caller.id, body, sent_at: yield* DateTime.now })
  yield* turn.emit(new MessageAdded({ id: turn.commandId, body }))
  return turn.commandId
})

// A helper's requirement states where it may run.
const requireOpen: Effect.Effect<void, RoomClosed, Chat.Turn> = Effect.gen(function* () {
  const turn = yield* Chat.Turn
  if (turn.state.closed) return yield* new RoomClosed()
})
```

## Phases

| Service        | Phase                                                   | Provides                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X.Turn`       | command handler (public or internal)                    | `id`, `ref`, `caller`, `principal`, `commandId`, `isNew`, writable `state`, `rows`, `blob`; read-only `group`; `emit`, `perform`, `broadcast`, `subscribe`, `unsubscribe`, `terminate`, `mint`; target: `cancelEffect`                             |
| `X.Read`       | query and stream handlers                               | `id`, `ref`, `caller`, `principal`, committed `state` and its event `cursor`, read-only `rows`, `group`, `blob`, and `events(Event, { after })`; stream handlers also get `follow(Event, { after })`                                               |
| `X.Connection` | connection handler (`open`, `frame`, `close`, `resync`) | `X.Read` capabilities plus `connectionId`, `member`, `session` (16 KiB), `resumed`, `send`, `broadcast`, `connections`, and `close`; `id` stays the actor id and `state` the actor's committed state                                               |
| `X.Workflow`   | workflow body                                           | owner `id` and `ref`, `principal`, `executionId`, `key`, and `version(name)`; waits, sleeps, and steps are `Ship.wait`/`sleep`/`step` constructors                                                                                                 |
| `X.Executor`   | effect executor                                         | `effectId`, `attempt`, `principal`, and owner `ref`; no database capability; `progress(E, frame)` for an effect declaring `progress` (executor side only; delivery is target, [ADR 0030](../decisions/0030-executor-progress-frames.md), proposed) |

Only command handlers may call `X.intents(id)`; it requires the runtime's `Actor.InTurn` marker, which command turns provide and `X.toLayer` removes from handler requirements. A command handler that acquires a handle with `X.get` does not compile. Request/reply handles (`X.get`) are available outside turns: in applications, effect executors, and connection handlers ([ADR 0023](../decisions/0023-connections-parking-and-streams.md)), and in workflow bodies only inside an activity. Workflows are target API; these workflow rules come from [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md), which changed the earlier text that let workflow bodies call `X.intents` and use handles anywhere. Executors report results by returning a value; the framework delivers it to the effect's `onSuccess` route ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)). `turn.mint(Child)` implements [ADR 0025](../decisions/0025-turn-mint.md)'s proposed defaults, pending acceptance: it returns the child's branded id, derived from the tenant, the parent's type and id, the command id, the call's ordinal within the command (from 0, across child types), and the child's type, so a rerun of the same command mints the same ids. It accepts only unkeyed actors that declare `policy.createdBy`; any other actor fails to compile and dies at runtime. Each minted id needs a creating intent to the child's `createdBy` command staged in the same turn, or the turn dies with `Minted actor <type>/<id> has no creating intent` and rolls back; that intent cannot take `Intent.key` (the turn dies with `Minted actor <type>/<id> has a keyed creating intent`), so no later keyed intent or cancel can remove it. That intent's caller is `System({ source, ref: <parent>, onBehalfOf, mint: { commandId, ordinal } })`, and only the relay, delivering the intent row the parent's turn committed to its outbox with a proof that derives the target id, may create the child; a System caller carrying `mint` through `Actor.as`, a client, or any other external entry point fails `Unauthorized` with code `access_denied` before its turn runs; any other caller of the creating command, including the parent without the proof, fails `Unauthorized` with code `access_denied` and no receipt. A captured `mint` dies with `Mint capability escaped its turn`. `turn.perform(effect)` is implemented on `X.Turn`; its `{ key, after, at }` options and `turn.cancelEffect(key)` are target API from [ADR 0024](../decisions/0024-effect-cancellation-and-per-actor-concurrency.md) (proposed), and a captured `cancelEffect` dies like a captured `perform`; and `X.Executor` is provided to executors in `X.toEffectLayer`. An effect layer whose executors or build Effect require `SqlClient`, `PgClient`, or `PgliteClient` does not compile, and the runtime removes those clients from the context an executor runs in. A client obtained outside Effect's context (for example a driver pool created in the build) is not detected. `X.Executor.attempt` starts at 1, and a later attempt may follow one whose outcome is unknown, so executors pass `effectId` to the provider as an idempotency key. Workflow bodies use the member's typed step constructors (`Ship.step`, `Ship.sleep`, `Ship.wait`, `Ship.race`), which compile to Effect's `Activity`, `DurableClock`, and `DurableDeferred`; the primitives used directly in a body die ([server API](01-server-api.md)). Wrap a step's `run` in Effect's `Activity.retry` to retry it: each attempt, numbered by `Activity.CurrentAttempt`, records its own exit and derives its own call ids, and a replay returns the final one. Effect's `Workflow.withCompensation` and `Workflow.addFinalizer` work in bodies; they run when the execution records its result, so a compensation runs when the execution fails or is interrupted, including an interrupt of a suspended execution, which replays the recorded steps to register them ([ADR 0044](../decisions/0044-workflow-engine-suite-drivers.md), proposed). A runner that dies while compensating replays and compensates again, so compensations must be idempotent. Inside a step's `execute`, each handle call gets a command id derived from the execution, step, attempt, and call order, so a rerun attempt repeats its ids; keep calls within one activity sequential, or use one call per activity. A call that would be sent past its id's expiry bound is not sent, and the activity dies with `ActivityOutcomeUnknown`.

## Subscriptions

`turn.subscribe(S, sourceId, { from? })` and `turn.unsubscribe(S, sourceId)` (target API, [ADR 0026](../decisions/0026-cross-actor-event-subscriptions.md)) start and stop following one source instance through a dynamic `Actor.subscription` (one without `route`). They stage like intents and take effect only if the turn commits. `from` is `"now"` (default), `"start"`, or a cursor to resume after. After `unsubscribe` commits, no further delivery for that source runs the handler. Routed subscriptions are not passed to either.

## Owned rows

`turn.rows(table)` and `read.rows(table)` accept only the actor type's declared `tables` and scope every operation to the current tenant and actor; `group` reads across the placement group. Neither takes ownership fields or predicates. The operations, filters, and rejected uses are in [Drizzle integration](04-drizzle.md).

## Blobs

`turn.blob(B)` and `read.blob(B)` accept only the actor type's declared `blobs` and address entries of the current tenant, actor type, and actor by name alone. `turn.blob` returns `BlobWrite` (`get`, `set`, `append`, `compact`), bound to the turn transaction, so a turn reads its own writes and a declared failure discards them. `read.blob` returns `BlobRead`, which has only `get`; the object carries no write methods, whatever a cast claims. `get` returns `Option.none()` for an entry that was never written and `Option.some` of an empty array for one set to no bytes.

```ts
const Attachments = Actor.blob("attachments")

// in a command handler
const files = (yield * Room.Turn).blob(Attachments)
yield * files.set(id, bytes)
yield * files.append("log", line) // a new chunk; earlier chunks are not rewritten
yield * files.compact("log") // one chunk, same bytes

// in a query handler
const file = yield * (yield * Room.Read).blob(Attachments).get(id)
```

## Command turns

A command's context is the only writable one. One framework-owned transaction performs, in order, the generation fence, receipt resolution, state decode (or reuse of the activation's cached state), handler, staged writes and intents, receipt update, and commit ([command turns](../contracts/02-command-turns.md)). `DateTime.now` is pinned per turn.

Unhandled declared failures roll back business changes and staged notifications while their terminal receipts commit and replay unchanged. A handler that catches an error and succeeds commits normally; an intentionally persisted rejection belongs in its output schema. Retryable turn failures, such as a stale generation or command execution timeout, become defects and restart the activation; the caller's handle retries with the same command id. A caller's `Timeout` stops waiting without cancelling the turn. Application errors are never wrapped.

## Events

`turn.emit(event)` takes an instance of a class declared in the actor's `events`; any other class fails to compile, and an undeclared or invalid value is a defect at runtime. The event is encoded when emitted and appended in the turn's own transaction, so a declared failure, a defect, or a crash before COMMIT leaves no event. Each committed event gets the next number in its actor's sequence, reserved on the locked generation row, so the sequence has no gaps or reuse even after pruning.

`read.events(Event, { after })` returns the committed events of one declared class after the exclusive cursor, oldest first, as `EventEntry` values:

```ts
interface EventEntry<E> {
  readonly cursor: string // pass as `after` to resume after this event
  readonly event: E
  readonly commandId: string // the command whose turn emitted it
  readonly timestamp: DateTime.Utc // database clock when the event was appended at commit
}
```

`after` defaults to the start of the stream. A cursor is the event's decimal sequence number, but callers should treat it as opaque. Replay fails with a typed error instead of skipping anything:

- `UnknownCursor { cursor }`: the cursor is malformed or ahead of every event this actor has committed.
- `RetentionGap { cursor }`: some event after the cursor has been pruned, whatever its class. The reader has to resynchronize from state.

A query that replays declares these in its `errors`, or handles them itself.

`read.cursor` is the last event committed when the query read `state`, and every `read.events` call in that query stops at it. Two replays of different classes in one query therefore line up, and a reader that takes `state` with `read.cursor` and then follows events after that cursor misses and repeats nothing. That is how a reader resynchronizes after `RetentionGap`.

Replay is paged: `read.events(E, { after, limit })` returns at most `limit` entries (default 1,000, at most 10,000; any other value is a defect). A full page means more may follow, so the reader continues after the last entry's cursor; a shorter page reached `read.cursor`. The events one turn emits may total at most 1,048,576 encoded bytes; the emit that crosses it is a deterministic defect, so the turn commits none of its events unless the handler catches that defect, in which case the events emitted before it commit and every later emit in the turn dies too. The limit bounds rows per page, not their bytes: a page of large events can be large. A stored event that no longer decodes under its current class makes the query a defect, so change an event's schema only in ways that still decode its stored events.

## Connections and streams

Connection members are implemented (M2.10) through the in-process holder transport; `Actor.stream` and `read.follow` below are still target API from [ADR 0023](../decisions/0023-connections-parking-and-streams.md) and are not implemented, and `conn.connections` does not yet take a page `cursor` (it returns the first 1,000). Connections are not served over HTTP until the WebSocket wire in M3.

A runtime's transport holds each socket; the actor never does. A connection member's handlers are `open(params)`, `frame(frame)`, and optional `close(reason)` and `resync({ after })`, each a short Effect with `X.Connection`. Handlers of one connection run one at a time in frame order, outside the command mailbox, and read the state the activation last committed.

- `conn.session.get` and `conn.session.set(patch)` read and change this connection's own state; `conn.state` is the actor's committed state, as in every read context. A changed session is written once, after the handler returns, fenced by the actor's generation; above 16 KiB encoded the handler is a defect that closes the connection and writes nothing.
- `conn.resumed` is `true` when this activation did not run the connection's `open`: after hibernation, a move to another runner, or a restart.
- `conn.send(frame)` sends to this connection. `conn.broadcast(frame, { except?, to? })` sends to this member's open connections, parked or not, wherever they are held. `turn.broadcast(Member, frame, { except?, to? })` does the same from a command and flushes after commit; `turn.connections(Member)` lists that member's open connections so a turn can filter them into `to`.
- `conn.connections({ cursor?, session? })` lists this member's open connections as `{ connectionId, caller, session? }`, at most 1,000 per page.
- A connection member may add `resync({ after })`, which runs on the new owner after an ungraceful owner death, with `resumed === true`, to replay what the client may have missed (it may not call `session.set`); the client receives a `Resync { after, reason, deadline }` control frame first and answers `ResyncDone { through }` within 30 seconds.
- Every member frame reaches the client as `{ frame, cursor?, event? }`. `cursor` is the activation's flushed-through watermark, the highest commit whose broadcasts to that holder all went out before this frame, and is how `Resync.after` is known; `event` is the cursor of the event the frame was sent from (`conn.send(entry)`, or `turn.broadcast(Member, entry)` with an `EventEntry`), which is what clients deduplicate on. After `Resync`, the client replays events after `after`, reloads state derived from frames that carry no event, waits for `ResyncReplayed` when the member has a `resync` handler, and answers `ResyncDone { through }` within 30 seconds. A member declared with `stampCursor: false` hides every cursor (`cursor`, `event`, the open baseline, `Resync.after`, and `ResyncReplayed.through`), cannot declare a `resync` handler, and its clients resync from state. The `resync` handler runs under the connection's current authorization, at bounded concurrency, and never without a cursor.
- `conn.close(reason?)` closes this connection. The client sees `ActorError` reason `SessionEnded` with cause `ServerClosed`. A `close` handler runs after the client is gone: its `conn.broadcast` reaches the member's other connections, and its `conn.send` is discarded.
- Connection handlers cannot write actor state, rows, events, or blobs. They call commands through `X.get`, including on the connection's own actor. Handlers run with the actor's tenant and the caller stored at open; the build Effect runs as a `System` caller, so handles acquired there carry no connection's identity. Frame handlers are at least once, so these calls get command ids derived by HMAC from a per-connection secret, the frame sequence, and the call index: a redelivered frame replays its commands' receipts, and no other caller can predict the ids.
- `conn.connections()` is paged and returns `session` only when asked. It shows every connection's caller, so don't send it to clients unfiltered.

`read.follow(Event, { after })` exists only in stream handlers. It replays the committed events after the exclusive cursor, then emits each new event as its turn commits, with no gap or repeat between the two, and fails with `UnknownCursor` or `RetentionGap` like `read.events`.

## Activation-local values

Values that live for one activation are ordinary Effect values in the layer's build closure, such as a `Ref`. They are not durable, not rolled back with a transaction, and gone after hibernation. Writable maintenance is an internal command, not a write from a read-only phase.

## Callers

`CurrentCaller` defaults to `Anonymous`. The edge sets it per request, `ActorTest.layer` per test, and `Actor.as(caller)` around an Effect; `X.get` captures it when the handle is acquired. `turn.caller` is the full caller and `turn.principal` the optional principal. Workflow bodies expose `principal` and act through handles carrying persisted System/on-behalf-of attribution.

A transaction-bound capability used after its turn ends dies. Owned rows, `group`, and blobs also die on any fiber other than the one running the turn or query, because its single connection takes no concurrent statements: `Effect.timeout`, `Effect.race`, `Effect.all` with concurrency, and explicit forks around them are defects, while sequential composition is not. A use from another fiber also fails the turn at its end, so a `race`, `exit`, or `catchDefect` that swallows the defect cannot commit the turn without the write. `state.set` and intents only stage values and are not bound to the fiber. Runtime guards still reject request/reply operations inside a turn even when a handle was captured outside it.
