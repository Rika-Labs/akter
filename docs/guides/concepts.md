# Concepts

**Responsibility:** explain the model a developer needs before reading the API reference: actors, turns, receipts, and the ways work continues after a turn.  
**Authority:** operational.  
**Owner role:** documentation.  
**Change policy:** change with the [runtime contracts](../contracts/README.md) when a guarantee described here changes; the contracts win on any conflict.

This page is a map, not a contract. Each section names the runtime contract that holds the precise rule.

## Actors

An actor is a named, addressable object that owns some data and handles one command at a time. You declare an actor type with `Actor.make(name, definition)`, which is the only way to make one. The definition is data: its key, state, events, owned tables, effects, and public members. Code lives in layers.

```ts
export const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})
```

An actor's identity is its type, its key, and its tenant. The key is one of three kinds:

- **Named.** A key schema, as above: `Counter.get("visits")`.
- **Singleton.** `key: Actor.singleton`, reached with `X.get()` and no id.
- **Minted.** No key: `X.create()` mints a new id, and `turn.mint(X)` derives a child's id inside its parent's turn.

Tenants are rows, not databases. Every framework row and every owned-table row carries its tenant, and a handle acquired under `Actor.tenant(tenant)` addresses only that tenant's actors. See [actor authority](../contracts/01-actor-authority.md).

## Turns

A command runs as a **turn**: one database transaction that, in order, checks that this runner still owns the actor (the generation fence), records or finds the command's receipt, decodes the actor's state, runs the handler, writes what the handler changed, and commits once. The handler reads and writes through `yield* X.Turn`, a service that exists only inside that transaction.

Everything the handler changes commits together or not at all: state, owned rows, events, blobs, the receipt, and the intents and effects it staged. A declared failure rolls all of it back and commits only the failure in the receipt, so a retry replays the same failure. See [command turns](../contracts/02-command-turns.md) and [Effect all the way into the commit](effect-into-the-commit.md).

Turns are short. A turn holds a database connection and the actor's lock for its whole duration, and `policy.commandTimeout` (30 seconds by default) bounds it. Anything slow or external belongs in an effect or a workflow.

## Receipts and command ids

Every command has a command id, minted once from the database clock and kept across retries. The receipt, written in the turn, is the only durable record that a command was accepted. When a caller retries with the same id, because a reply was lost or the runner restarted, the runtime finds the receipt and returns the recorded result without running the handler again.

Commands are direct: the caller's handle sends the command to the actor's owner and waits for the reply, retrying with the same id until `policy.deliveryTimeout` (30 seconds by default). There is no durable queue of incoming commands. Work that must survive the caller crashing is staged by a turn as an intent, or run as a workflow. See [receipts](../contracts/04-receipts.md).

## State, tables, events, and blobs

- **State** is a schema-typed object per actor, `Actor.state(fields, { migrations? })`, stored compressed and capped by `policy.maxStateBytes` (64 KiB by default). Old shapes upcast through declared migrations.
- **Owned tables** are ordinary Drizzle tables declared with `Actor.table`. The framework adds routing, tenant, and actor columns and scopes every read and write to the current actor, so a handler cannot touch another actor's rows. See [Drizzle integration](../api/04-drizzle.md).
- **Events** are declared classes appended with `turn.emit`. Each actor's events are numbered without gaps, and readers resume after a cursor with `read.events`.
- **Blobs** hold binary entries per actor, written through the same transaction.

## Queries and reducers

A **query** reads committed state and owned rows through `yield* X.Read`. It never activates the actor, takes its lock, or writes a receipt. A **reducer** is a pure `reduce(state, input)` transition that runs as an ordinary turn on the server, and optimistically in the [Promise client](../api/03-typescript-sdk.md).

## Work after the turn

A turn cannot call another actor and wait, or call an external service. It stages work that runs after it commits:

- **Intents** call a command on another actor, or on itself. `X.intents(id)` exists only inside a turn; the intent is written to an outbox in the same commit and delivered after it. Delivery can repeat, and the receiver's receipt removes the duplicate. `Intent.after`, `Intent.at`, and `Intent.key` make an intent a timer that can be replaced or cancelled. See [messaging](../contracts/05-messaging.md).
- **Effects** call the outside world. `turn.perform(effect)` records the effect in the commit; an executor, outside any transaction, runs it with retries and reports the result back to the actor as a new turn (`onSuccess`), or dead-letters it (`onDeadLetter`). An executor can run more than once for one effect, so it passes `effectId` to the provider as an idempotency key. See [background work](../contracts/08-background-work.md).
- **Workflows** are actor members for multi-step processes with durable sleeps, waits on the actor's own events, and recorded steps. They are started by a turn or a caller and belong to the actor that runs them.

## Callers and authorization

Every call carries a caller: a `User`, `Anonymous`, or a `System` caller for framework deliveries. `Actors.layer({ authorize })` requires an authorization callback, which sees the caller, the target actor, and the command before the turn runs. `Actor.as(caller)` and `Actor.tenant(tenant)` set the caller and tenant around acquiring a handle; `Actor.serve` sets them from the request. A retried command is authorized again. See [security](../contracts/10-security.md).

## Where actors run

- **Embedded.** Your process provides `Actors.layer` and calls actors as Effects. The quickstart app runs this way.
- **Served.** `Actor.serve` exposes public commands, reducers, and queries over HTTP with an OpenAPI document. WebSocket and SSE are not served yet.
- **Hosted.** Managed runners are planned, not available.

Today, run one runtime process per database. The [support matrix](../operations/support-matrix.md) lists what has been verified on each backend, and [deploy](deploy.md) covers running in production.

## What it does not promise

- Broadcasts to connected clients are not durable; a client that misses one resynchronizes from state and events.
- Effects are not exactly once. The framework records one result per effect id; the provider's idempotency keeps the external call from applying twice.
- Process memory, TypeScript types, and a lease alone are never authority. The generation fence in the database decides which runner may commit.
