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
| `X.Read`       | query and stream handlers            | `id`, `ref`, `caller`, `principal`, committed `state`, read-only `rows`, `group`, `blob`, and `events(Event, { after })`                                   |
| `X.Connection` | connection handler                   | `X.Read` capabilities plus connection `id`, `state` (16 KiB), `resumed`, and `broadcast`                                                                   |
| `X.Workflow`   | workflow body                        | owner `id` and `ref`, `principal`, `executionId`, `key`, and owner-event `waitFor(Event, { where, timeout })`                                              |
| `X.Executor`   | effect executor                      | `effectId`, `attempt`, `principal`, and owner `ref`; no database capability                                                                                |

Only command handlers and workflow bodies may call `X.intents(id)`; it requires the runtime's `Actor.InTurn` marker, which command turns provide and `X.toLayer` removes from handler requirements (workflow bodies are target API). A command handler that acquires a handle with `X.get` does not compile. Request/reply handles (`X.get`) are available outside turns: in applications, workflow bodies, and effect executors. Executors report results by returning a value; the framework delivers it to the effect's `onSuccess` route ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)). Workflow activities and durable sleep use Effect's `Activity` and `DurableClock`.

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

## Activation-local values

Values that live for one activation are ordinary Effect values in the layer's build closure, such as a `Ref`. They are not durable, not rolled back with a transaction, and gone after hibernation. Writable maintenance is an internal command, not a write from a read-only phase.

## Callers

`CurrentCaller` defaults to `Anonymous`. The edge sets it per request, `ActorTest.layer` per test, and `Actor.as(caller)` around an Effect; `X.get` captures it when the handle is acquired. `turn.caller` is the full caller and `turn.principal` the optional principal. Workflow bodies expose `principal` and act through handles carrying persisted System/on-behalf-of attribution.

A transaction-bound capability used after its turn ends, or from a fiber forked inside it, dies. Runtime guards still reject request/reply operations inside a turn even when a handle was captured outside it.
