# Context capabilities

**Responsibility:** define `Context` phases and capabilities.  
**Authority:** API contract.  
**Owner role:** API/runtime.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Handler context is passed explicitly as the first argument: `(ctx, input)`. Capabilities depend on the execution phase; the runtime remains the final authority even when TypeScript prevents invalid use.

## Command turns

A command receives the only writable context. One framework-owned transaction performs, in order, the generation fence, receipt lookup, handler, events and durable intents, effects, receipt update, and commit. The context provides writable scoped rows and keyed state, blob writes, `ctx.emit`, `ctx.perform`, timers, and durable sends through `ctx.self` and `ctx.actors`.

Declared failures are recorded in receipts and replayed unchanged. Retryable turn failures such as a stale generation or command execution timeout become defects and redelivery; caller-side delivery failures use narrowed `ActorError` reasons. A caller's `Timeout` stops waiting without cancelling or restarting the admitted turn. Application errors are never wrapped.

## Read-only and off-turn phases

Capabilities are explicit rather than inherited from one universal context:

| Phase                  | Durable data access                                                    | Other capabilities                                                                                     |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Command                | Transaction-bound state, scoped rows, and `ctx.blob` writes.           | `caller`, `principal`, `vars`, events, effects, timers, actor/workflow intents, post-commit broadcast. |
| Query                  | Committed state values, `ScopedRead`, and `BlobRead`; no activation.   | `caller` and `principal`; no `vars`, `state.changes`, or intent handles.                               |
| Stream                 | Read-only rows/blobs and committed `StateSnapshot`.                    | `caller`, `principal`, `vars`, events and connection operations; live stream, not a turn.              |
| Connection             | Stream read capabilities, plus separate per-connection state.          | `conn.caller`, `conn.state`, `conn.resumed`, and `self` intents.                                       |
| Wake/sleep/defect hook | Read-only activation state, rows, and blobs.                           | `vars` and `self` intents; no user caller property.                                                    |
| `run`                  | Wake-context reads; no turn transaction.                               | `vars`, `self`/`actors` intents, events, connections; interrupted on sleep.                            |
| Effect executor        | No database or direct actor-state capability.                          | `principal`, `commandId`, `attempt`, and `self` result intents.                                        |
| Workflow body          | No direct actor-state/row capability; actor calls use their own turns. | `owner`, `actors`, `principal`, `executionId`, `key`, activities, durable sleep, owner-event waits.    |

Activation `StateSnapshot.changes` publishes only committed values. `vars` are typed activation-local values, are not rolled back with a transaction, and disappear on hibernation. Writable maintenance is an internal command, not a write from a read-only hook.

Connections expose `ctx.conn.state` with a 16 KiB limit and `ctx.conn.resumed`. `Connections.park` permits activation hibernation while the transport keeps the socket open; it does not preserve a socket after its transport process dies.

`CurrentCaller` defaults to `Anonymous`. `X.get`/`X.create` captures it when acquiring the handle, or uses an explicit `{ as }` override; methods do not re-read it on each call. Command context exposes the full `ctx.caller` and optional `ctx.principal`. Workflow bodies expose `principal` and use persisted System/on-behalf-of attribution through their actor handles, not a `ctx.caller` property.

The `Turn` service allows deep helpers to access the current command context; it exists only inside that phase. Runtime guards still reject request/reply operations inside a turn even when a handle was captured outside it.
