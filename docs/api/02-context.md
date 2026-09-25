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

| Service        | Phase                                | Provides                                                                                                                                                   |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X.Turn`       | command handler (public or internal) | `id`, `ref`, `caller`, `principal`, `commandId`, `isNew`, writable `state`, `rows`, `blob`; read-only `group`; `emit`, `perform`, `broadcast`, `terminate` |
| `X.Read`       | query and stream handlers            | `id`, `ref`, `caller`, `principal`, committed `state` and its event `cursor`, read-only `rows`, `group`, `blob`, and `events(Event, { after })`            |
| `X.Connection` | connection handler                   | `X.Read` capabilities plus connection `id`, `state` (16 KiB), `resumed`, and `broadcast`                                                                   |
| `X.Workflow`   | workflow body                        | owner `id` and `ref`, `principal`, `executionId`, `key`, owner-event `waitFor(Event, { where, timeout, name? })`, and `version(name)` (proposed)           |
| `X.Executor`   | effect executor                      | `effectId`, `attempt`, `principal`, and owner `ref`; no database capability                                                                                |

Only command handlers and workflow bodies may call `X.intents(id)`; it requires the runtime's `Actor.InTurn` marker, which command turns provide and `X.toLayer` removes from handler requirements (workflow bodies are target API). A command handler that acquires a handle with `X.get` does not compile. Request/reply handles (`X.get`) are available outside turns: in applications, workflow bodies, and effect executors. Executors report results by returning a value; the framework delivers it to the effect's `onSuccess` route ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)). `turn.perform(effect)` is implemented on `X.Turn`, and `X.Executor` is provided to executors in `X.toEffectLayer`. An effect layer whose executors or build Effect require `SqlClient`, `PgClient`, or `PgliteClient` does not compile, and the runtime removes those clients from the context an executor runs in. A client obtained outside Effect's context (for example a driver pool created in the build) is not detected. `X.Executor.attempt` starts at 1, and a later attempt may follow one whose outcome is unknown, so executors pass `effectId` to the provider as an idempotency key. Workflow activities and durable sleep use Effect's `Activity` and `DurableClock`. Proposed in [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md): workflow bodies cannot call `X.intents`, and handles work only inside an activity, where each call gets a command id derived from the execution, step, attempt, and call order, so a re-run attempt repeats its ids. Keep calls within one activity sequential, or use one call per activity.

## Owned rows

`turn.rows(table)` and `read.rows(table)` accept only the actor type's declared `tables` and scope every operation to the current tenant and actor; `group` reads across the placement group. Neither takes ownership fields or predicates. The operations, filters, and rejected uses are in [Drizzle integration](04-drizzle.md).

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

Replay is not limited to a page size yet, and emits have no size budget of their own; both are follow-ups next to `keepEvents`. A stored event that no longer decodes under its current class makes the query a defect, so change an event's schema only in ways that still decode its stored events.

## Activation-local values

Values that live for one activation are ordinary Effect values in the layer's build closure, such as a `Ref`. They are not durable, not rolled back with a transaction, and gone after hibernation. Writable maintenance is an internal command, not a write from a read-only phase.

## Callers

`CurrentCaller` defaults to `Anonymous`. The edge sets it per request, `ActorTest.layer` per test, and `Actor.as(caller)` around an Effect; `X.get` captures it when the handle is acquired. `turn.caller` is the full caller and `turn.principal` the optional principal. Workflow bodies expose `principal` and act through handles carrying persisted System/on-behalf-of attribution.

A transaction-bound capability used after its turn ends, including from a forked fiber, dies. Runtime guards still reject request/reply operations inside a turn even when a handle was captured outside it.
