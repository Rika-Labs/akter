# Context capabilities

**Responsibility:** define `Context` phases and capabilities.  
**Authority:** API contract.  
**Owner role:** API/runtime.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Handler context is passed explicitly as the first argument: `(ctx, input)`. Capabilities depend on the execution phase; the runtime remains the final authority even when TypeScript prevents invalid use.

## Command turns

A command receives the only writable context. One framework-owned transaction performs, in order, the generation fence, receipt lookup, handler, events and durable intents, effects, receipt update, and commit. The context provides writable scoped rows and keyed state, blob writes, `ctx.emit`, `ctx.perform`, timers, and durable sends through `ctx.self` and `ctx.actors`.

Declared failures are recorded in receipts and replayed unchanged. Retryable framework failures become defects and redelivery; application errors are never wrapped.

## Read-only and off-turn phases

Queries run against committed data without waking the actor. Query, stream, connection, wake, sleep, and `run` contexts expose read-only rows and state snapshots. Writable maintenance is an internal command sent to the actor.

`vars` are typed activation-local values available to actor contexts. They are discarded on hibernation. Connections expose `ctx.conn.state` with a 16 KiB limit and `ctx.conn.resumed`; `Connections.park` permits hibernation while sockets remain open.

Workflow bodies use a workflow context and may call other actors, run durable steps, sleep, and wait for owner events. They do not hold a command transaction open.

`CurrentCaller` defaults to `Anonymous` and is bound at the edge. `ctx.caller` preserves the full caller and `ctx.principal` exposes its optional principal.
