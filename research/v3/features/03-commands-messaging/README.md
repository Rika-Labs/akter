# 03 — Durable commands, queries and messages

**Status:** accepted semantic core; actual transaction, fence and publication implementation still needs proof.

[Index](../../README.md) · [Decisions](../../DECISIONS.md) · [Storage](../02-relational-storage/README.md) · [External effects](../09-external-effects/README.md)

## Product contract

Stable actor identities receive typed commands. Authoritative turns serialize per actor; other actors proceed concurrently. Durable acceptance is not execution success. A timed-out caller does not know whether its command committed.

```diagram
accept command + stable ID → persist inbox
                                   │
                                   ▼
┌──────────────── one transaction ───────────────────┐
│ lock actor · validate generation · consult receipt │
│ handler writes · events · timers · outgoing intents│
│ result receipt · inbox completion · actor version  │
└────────────────────────┬───────────────────────────┘
                         │ COMMIT confirmed
                         ▼
                 reply / notify / relay
```

## Proposed command usage

```ts
const ctx = yield* Context
const [message] = yield* ctx.database.insert(messages).values({
  id: input.id,
  authorId: ctx.caller.userId,
  body: input.body,
  sentAt: ctx.now,
}).returning()

yield* ctx.emit("messageAdded", message)
yield* ctx.send(
  Notifications.ref({ tenantId: ctx.tenant.id, id: input.recipientId }),
  "messageReceived",
  { roomId: ctx.id, messageId: message.id },
)
return message
```

`ctx.send` appends a source-owned intent and returns without waiting for destination execution. Even colocated actors need not share one command transaction. A single outbox path is the v2 simplification proposal; a fast path must earn its complexity and preserve the same external guarantees.

Outside a turn, request/reply and acceptance handles are available:

```ts
const commandId = crypto.randomUUID() // keep for this logical operation
const result = await room.commands.sendMessage(input, { commandId })

// Proposed asynchronous submission variant.
const pending = await room.submit("sendMessage", input, { commandId: anotherId })
const outcome = await client.submissions.get(pending.id)
```

Same ID plus same validated input resolves to the same recorded outcome within retention. Same ID plus changed input is a conflict. Stable IDs must be scoped by tenant/actor/protocol identity; a global client string alone is not sufficient.

## Fences, rejection and retries

- Ownership generation is checked under the database authority; runner placement leases alone are insufficient.
- A stale runner cannot commit after the new generation is installed. A turn already holding the authority lock can serialize before handoff.
- First activation/initialization is race-safe. Recreating a purged actor must not accidentally accept messages from an old lineage.
- Typed domain rejection must not commit staged business changes. A savepoint-plus-rejected-receipt design is a proposal, not an inherited proof.
- Transient database failures, malformed requests, domain rejection and handler defects need different handling. No fixed three-retry policy is approved.
- Handler execution can repeat after rollback. Do not run irreversible external effects in the handler.
- Disconnect during COMMIT is unknown until receipt/state reconciliation. Do not blindly interpret it as rollback.

## Queries and ordering

Actor queries are volatile reads interpreted by the owner, distinct from durable mutation commands. Shared SQL queries bypass actor messaging and retain database consistency limits. A proposed `afterVersion` read waits for an actor version or fails/times out; it must not manufacture a global snapshot or wait inside another actor's transaction.

```ts
const result = await room.commands.sendMessage(input, { commandId })
const snapshot = await room.queries.recentMessages({
  afterVersion: result.version,
})
```

This excerpt assumes an optional versioned result envelope; final envelope shape is undecided. No global FIFO across senders or actors is promised. Per-actor event order and any requested source-message ordering need durable sequences, not UUID or wall-clock sorting.

## Failure recovery

```diagram
source intent committed
          │ relay
          ▼
destination inbox committed
          │ ack lost / relay crashes
          ▼
retry same identity → destination deduplicates
```

Notifications are acceleration hints. Durable polling/scan paths must recover missed hints. Limit mailbox depth, payload size, fanout, attempt rate, and command duration. Track oldest pending age; a queue that accepts forever is not durable progress.

Receipt retention must outlast supported retries and dependent pending deliveries. Replay after pruning can duplicate an effect unless tombstones or a stricter expiry policy prevent it. Restore requires epoch/reconciliation handling, especially when the external world has advanced.

## Validation gates

1. Fail between every turn write and outer commit; no partial business/event/receipt/intents survive.
2. Stall or fail outer commit after a nested savepoint; no client or stream observes success early. v2 recorded this as an unresolved Effect callback risk.
3. Race two activations and pause the old writer; prove fence behavior with independent processes/connections.
4. Lose relay acknowledgements and duplicate messages; one committed destination transition within the dedupe contract.
5. Expire retention while work remains pending; cleanup cannot destroy necessary dedupe evidence.
6. Saturate one hot actor; bounded admission preserves progress for unrelated actors.
7. Exercise single-shard mode and actual routing on Neki; business and runtime rows participate in the same transaction domain.
