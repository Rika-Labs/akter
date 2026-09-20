# 01 — Actor definition and context

**Status:** accepted product direction; the API below is proposed, not implemented.

[Index](../../README.md) · [Decisions](../../DECISIONS.md) · [Storage](../02-relational-storage/README.md) · [Realtime](../04-realtime/README.md)

## Goal

One actor definition describes behavior and its typed capabilities. One `yield* Context` exposes the capabilities valid in the current execution phase. The framework is Effect-native; the Promise SDK is a boundary adapter, not a second runtime.

An actor has durable identity and exclusive mutation authority over its rows. Its current process, in-memory cache, connections, and parent business relationship are not that identity. Shared SQL observation is a deliberate extension beyond strict message-only actor encapsulation.

```diagram
┌──────────────────────────┐
│ Actor.define             │
│ tables · commands        │
│ queries · events         │
│ subscriptions · signals  │
│ presence · lifecycle     │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ Runtime provides Context │
│ specific to phase        │
└─────────────┬────────────┘
              ▼
┌──────────────────────────┐
│ Handler uses ctx.*       │
└──────────────────────────┘
```

## Proposed actor example

`messages`, `Message`, and `loadRecentMessages` are application declarations illustrated in the storage and realtime documents. Validation and authorization are explicit, not inferred from a caller-supplied actor ID.

```ts
import { Actor, Context } from "durable-actors"
import { Effect, Schema } from "effect"

export const Chat = Actor.define({
  name: "chat",
  tables: { messages },
  events: { messageAdded: Message },

  commands: {
    sendMessage: {
      input: Schema.Struct({ id: Schema.String, body: Schema.String }),
      output: Message,
      handler: (input) => Effect.gen(function* () {
        const ctx = yield* Context
        const access = yield* RoomAccess
        yield* access.requireMember(ctx.caller, ctx.address)
        const body = input.body.trim()
        if (!body || body.length > 4_000) {
          return yield* ctx.reject("InvalidMessage")
        }
        const [message] = yield* ctx.database.insert(messages).values({
          id: input.id,
          authorId: ctx.caller.userId,
          body,
          sentAt: ctx.now,
        }).returning()
        yield* ctx.emit("messageAdded", message)
        return message
      }),
    },
  },

  subscriptions: {
    messages: {
      snapshot: loadRecentMessages,
      events: ["messageAdded"],
    },
  },
  presence: {
    metadata: Schema.Struct({ displayName: Schema.String }),
  },
  signals: {
    typing: Schema.Struct({ active: Schema.Boolean }),
  },
  lifecycle: { hibernateAfter: "30 seconds" },
})
```

There is no second realtime registration. Schema-derived wire contracts include command/query inputs, results, domain errors, event bodies, presence metadata, and signals. Runtime decoding is required even when callers use TypeScript.

## Context capability matrix

| Context | Database | Other capabilities |
| --- | --- | --- |
| Actor command | Actor-local writer in current transaction | Emit event; record sends, timers, work/transfer intents; reject |
| Actor query/snapshot | Read-only actor scope at the promised version | Identity, tenant, authorized caller; no mutation |
| Application/dashboard/live SQL | Shared authorized read-only access | Caller/tenant and subscription lifetime; no current actor assumed |
| Activation/connection hook | No retained turn writer | Supervised resources, signals, enqueue commands through non-turn references |
| Activity/job | Authorized read-only observations | External services, scoped blobs, result reporting |
| Workflow | Observations through defined steps/queries | Journaled steps, sleep, approval, actor requests outside turn locks |

`ctx.id` is a convenient actor-local ID. `ctx.address` carries the complete namespace/type/ID identity. `ctx.tenant` is validated tenancy, not the identity of the human caller. `ctx.caller` can represent an authenticated user or service; internal commands must not invent a user principal.

Effect already exports `Context`. Service-definition files may alias that import to `EffectContext`; the framework need not re-export Effect wholesale. Application services such as `RoomAccess` remain ordinary Effect dependencies.

## Type and lifetime limits

The generator body does not automatically infer its phase merely because it appears under `commands`. The type design must make the callback requirement compatible with the provided context, and reject dependencies valid only outside turns. Candidate mechanisms include context-specific callback builders or phase-indexed service requirements; final syntax must pass type tests before being frozen.

TypeScript cannot generally prove the ownership of a row named by a runtime string, nor prevent every `any` cast or leaked closure. Runtime transaction handles must reject use after turn completion and after fence loss. Lifecycle handlers cannot mint a writer by retrieving the same service name.

## Validation gates

- Compile positive/negative fixtures for each phase: command insert succeeds; dashboard insert, command blob upload, and activation turn-writer access fail.
- Attempt a captured query after transaction completion; fail rather than execute on a new pooled connection.
- Run identical local IDs under different types and tenants; identity and authorization remain distinct.
- Send malformed messages from plain JavaScript; runtime schemas reject them.
- Revoke membership; commands, snapshots and resumed subscriptions enforce the documented revocation boundary.

The runtime's support for these contracts is not established by the examples.
