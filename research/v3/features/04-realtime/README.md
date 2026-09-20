# 04 — Actor-integrated realtime

**Status:** accepted capability; transport, replay and authorization mechanisms are proposed.

[Index](../../README.md) · [Context](../01-actor-context/README.md) · [Live SQL](../11-live-sql/README.md) · [Hibernation](../12-connection-hibernation/README.md)

## Goal

Define realtime alongside commands on the actor. Use the context to emit durable events or handle ephemeral signals. Derive typed client subscriptions from that same definition; no separate `Realtime.forActor` registration.

```diagram
command → business write + event → COMMIT
                                      │
                                      ▼
snapshot + cursor → retained replay → live delivery
                                      │
                             disconnect / restart
                                      ▼
                         replay or explicit reset
```

## Proposed actor declaration

```ts
import { Actor, Context } from "durable-actors"
import { Effect, Schema } from "effect"
import { desc } from "durable-actors/drizzle"

const Chat = Actor.define({
  name: "chat",
  tables: { messages },
  commands: chatCommands,
  events: { messageAdded: Message },
  subscriptions: {
    messages: {
      snapshot: Effect.gen(function* () {
        const ctx = yield* Context
        return yield* ctx.database.select().from(messages)
          .orderBy(desc(messages.sentAt), desc(messages.id)).limit(100)
      }),
      events: ["messageAdded"],
    },
  },
  presence: {
    metadata: Schema.Struct({ displayName: Schema.String }),
  },
  signals: {
    typing: Schema.Struct({ active: Schema.Boolean }),
  },
})
```

`Message`, `messages`, and `chatCommands` are application placeholders. Actor snapshots use actor-scoped read contexts. This snapshot is bounded recent history, not an assertion that all messages fit in memory. Older history uses pagination.

```ts
// Command context: durable, part of the turn.
yield* ctx.emit("messageAdded", message)

// Connection/signal context, outside the command transaction: ephemeral.
yield* ctx.signals.publish("typing", { active: true })
```

Signal payloads cannot select their authenticated sender. Presence metadata such as display names is untrusted display data; principal identity is server-attached. Optional signal handlers validate/rate-limit input before broadcasting. Signals are not a backdoor for business mutations.

## Client experience

```ts
await room.presence.join({ displayName: "Dallen" })
await room.signals.typing.publish({ active: true })
for await (const frame of room.subscriptions.messages({ signal })) {
  if (frame.type === "snapshot") replaceRecentMessages(frame.data)
  else upsertMessage(frame.event.data)
}
```

The SDK reconnects and tracks cursor with its current local state. A persisted cursor without its matching state cannot reconstruct a view after a fresh page load; start with a snapshot or persist both. Full-row message events permit idempotent upsert; delta events require their own sequence/deduplication semantics.

## Durability and ordering

| Channel | Contract |
| --- | --- |
| Durable event | Committed actor event with sequence; replay within retention |
| Snapshot | Authorized state paired with a matching replay boundary |
| Presence | Connection/gateway-scoped leased state with expiry |
| Ephemeral signal | Best effort; loss/coalescing allowed; no durable replay |
| Token stream | Usually ephemeral; final answer can be an actor command/event |

Snapshot acquisition and cursor selection must be one consistent actor-local boundary. Do not SELECT state and later read an unrelated max sequence. Commit order, not message timestamps, defines the durable event cursor.

On retention expiry, overflow or incompatible cursor lineage, explicitly reset/resnapshot. No silence that looks like continuity. Owner migration and activation sleep are handled by routing/gateway lifetimes; no global ordered event stream across actors is implied.

An event log is not automatically event-sourced business truth. SQL rows remain authoritative; the log supports delivery/audit according to its retention contract.

## Auth and resource limits

Authenticate connections and authorize each subscription, initial snapshot, replay and publish operation. Reauthorize on permission epoch changes/refresh; old buffered data cannot leak after the promised revocation boundary. Tenant input from the browser is a requested scope, not proof of permission.

Bound payloads, subscriptions, per-connection queues, replay rates, retained history and concurrent snapshots. Slow consumers can receive an explicit resync or disconnect. Do not block an actor command on a slow network client or assume a broadcast was delivered because it was enqueued.

## Validation gates

- Race snapshot creation with commands; all committed changes appear in snapshot or subsequent replay, without gaps.
- Roll back a command that emitted an event; no subscriber sees that event.
- Lose notifications and restart routing/relay components; replay still catches up.
- Expire cursors and recreate an actor identity; reject stale lineage and reset explicitly.
- Revoke membership with queued replay data; unauthorized messages stop at the declared boundary.
- Stall a consumer while healthy consumers continue; memory is bounded and command completion is not tied to socket speed.
- Compare presence expiry with reconnect churn; no durable-state claim depends on a perfectly detected disconnect.
