# 12 — Connection-preserving hibernation

**Status:** accepted product capability; gateway protocol and API below are proposed and unimplemented.

[Specification index](../../README.md) · [Decisions](../../DECISIONS.md) · [Sources](../../SOURCES.md) · [External effects](../09-external-effects/README.md) · [Live SQL](../11-live-sql/README.md)

## Product contract

An actor activation may sleep while clients remain connected. A connection gateway—not the actor—owns transport sockets, typed logical connection state, replay cursors, and bounded outbound buffering. Relevant input wakes or invokes the actor through durable messaging.

Hibernation does not checkpoint arbitrary fibers, stacks, closures, transaction handles, or in-memory application objects. Gateway loss, process failure, network change, browser suspension, or retention expiry can still disconnect clients; reconnect is part of the protocol.

```diagram
client WebSocket / SSE
          │ physical transport
          ▼
┌──────────────── connection gateway ────────────────┐
│ logical connection ID · principal · metadata       │
│ subscriptions · replay cursors · bounded buffers   │
└───────────────┬──────────────────────┬─────────────┘
                │ durable command      │ live-query updates
                ▼                      ▼
       actor activation             query service
       awake only as needed
                │
                └── passivates; gateway remains alive
```

The gateway may be colocated with other runtime roles, but its lifecycle is independent of an actor activation. “Connection survives actor sleep” does not mean “socket survives gateway failure.”

## Proposed API

Realtime, connection, and lifecycle declarations belong within `Actor.define`; there is no separate registration API. Names and types are sketches, not compiler-tested exports.

```ts
import { Actor, Context } from "durable-actors"
import { Effect, Schema } from "effect"

export const Room = Actor.define({
  name: "room",
  connections: {
    member: Actor.connection({
      metadata: Schema.Struct({
        roomId: Schema.String,
        deviceId: Schema.String,
        clientVersion: Schema.String,
      }),
      inbound: Schema.Union(SendMessage, SetTyping),
      outbound: Schema.Union(MessageAdded, PresenceChanged, ResyncRequired),
    }),
  },
  events: {
    messageAdded: MessageAdded,
  },
  subscriptions: {
    timeline: { snapshot: loadRecentMessages, events: ["messageAdded"] },
  },
  lifecycle: {
    hibernateAfter: "30 seconds",
  },
  commands: {
    send: {
      input: SendMessage,
      handler: ({ id, body }) => Effect.gen(function* () {
        const ctx = yield* Context
        // Authorization and body validation are omitted in this excerpt.
        const [message] = yield* ctx.database.insert(messages)
          .values({ id, body, authorId: ctx.caller.userId }).returning()
        yield* ctx.emit("messageAdded", message)
      }),
    },
  },
})
```

`loadRecentMessages`, schemas, and the registered message table are application placeholders. A connection hook has no turn-bound writer; persistent connection auditing, if required, must enqueue an internal command rather than write business rows in the hook.

The logical connection record is typed and versioned. Proposed metadata contains connection ID, actor subscription target, principal/tenant, authentication and policy epochs, device/session ID, protocol version, connected/last-seen times, subscriptions, and replay cursors. Metadata is bounded and schema-decoded; it is not an arbitrary object heap.

## Connection and wake flow

```diagram
connect → authenticate → allocate/resume logical connection
   │                          │
   │                          ├── subscribe / replay without actor wake
   │                          └── actor-directed input
   │                                      │
   │                                      ▼
   │                              durable inbox + dedupe
   │                                      │
   └────────────────────────────── wake/route activation
                                          │
                                   command commits
                                          │
                              publish → gateway → client
```

Transport acknowledgement means the gateway accepted a frame, not that an actor command committed. Commands carry stable request IDs and expose durable receipts. The gateway may deliver more than once after reconnect or crash; the actor inbox deduplicates within its declared retention window.

Connect/disconnect/presence callbacks must define whether they are hints or durable commands. Rapid transport churn should not create unbounded actor wakes. Presence is leased derived state, not proof a human remains online.

## Reconnect and dedupe

Clients retain a logical connection token, protocol version, last acknowledged outbound cursor, and stable IDs for unconfirmed inbound requests. Resume validates tenant, principal, device policy, expiry, and gateway epoch before rebinding a new transport.

A reconnect can race the old socket. The gateway chooses one current transport generation and fences writes from stale generations. Repeated subscribe, unsubscribe, inbound command, and acknowledgement frames are idempotent by logical connection plus message ID/request hash. Reusing an ID with changed content is rejected.

If replay history is gone or cursor continuity cannot be proven, the gateway emits `resync-required`. Clients refresh snapshots and do not infer that no events occurred.

## Authentication refresh

Long-lived transport authentication expires. The gateway requests refresh before expiry, verifies new credentials, updates principal/policy epochs, and reauthorizes every subscription. Until refresh succeeds it may pause privileged inbound frames and outbound protected data.

Revocation must have a bounded propagation target. A refreshed identity cannot inherit subscriptions it no longer may access. Buffers created under an old authorization epoch are discarded or re-filtered; opaque encrypted buffering alone does not prove authorization.

Resume tokens are short-lived, audience-bound, rotation-capable, and non-authoritative without server-side generation state. Logs and client-visible errors do not expose other actor or connection existence.

## Wake storms and backpressure

Gateways coalesce presence hints, batch eligible signals, and enforce per-tenant, actor, connection, and IP limits. Wakes have concurrency budgets, jitter, admission queues, and overload responses. A reconnect wave after gateway restart must not activate every actor simultaneously.

Outbound queues are bounded by bytes, messages, and age. State-like updates may coalesce; ordered durable events require replay or resync. Slow consumers are paused or disconnected rather than consuming unlimited memory. Gateway buffering is not the durable event log.

Inbound frames are size/rate limited and schema-decoded before wake. Fairness prevents one hot actor or tenant from exhausting activation capacity.

## Failure limits

- Actor sleep preserves no arbitrary user fiber, local timer, open transaction, or process memory.
- Gateway process loss disconnects physical sockets unless a transport-specific handoff exists; clients reconnect.
- Logical connection metadata may survive gateway loss, but exactly-once frame delivery is not promised.
- Lost gateway notifications are repaired through durable cursors/inboxes where the feature requires recovery.
- Network partitions can leave both ends believing a connection exists; leases and generations converge later.
- Commands remain short turns. A socket does not extend transaction lifetime.
- Shared SQL/realtime consistency retains the limits in [live SQL](../11-live-sql/README.md).
- Restore invalidates or epochs old resume tokens and dedupe state to avoid accepting stale generations.

## Long-running work

Model calls, tool use, uploads, and other long-running operations use `ctx.activities`, jobs, or workflows. They are independent of the actor activation and client socket. The initiating command records work durably, then returns an operation ID; progress and completion flow through durable events/subscriptions.

Disconnecting a client does not automatically cancel work. Cancellation is an authorized durable command and remains cooperative. Reconnecting observes status by operation ID rather than recovering an in-memory promise or fiber.

## Operations and privacy

Measure connected transports, logical sessions, resumed versus fresh connects, wake rate, wake suppression, auth-refresh failures, stale generations, replay lag, resyncs, queue bytes, slow-consumer disconnects, and command receipt latency.

Connection metadata has explicit retention and minimization. Device IDs, addresses, and principal claims can be sensitive; restrict query access, redact logs, encrypt where required, and delete expired sessions without deleting command receipts still needed for dedupe.

## Unresolved specifics

- Gateway persistence model, clustering, placement, and failover behavior.
- WebSocket/SSE feature parity and transport handoff feasibility.
- Logical connection token format, lease durations, and replay retention.
- Durable versus hinted lifecycle callbacks and presence semantics.
- Auth refresh protocol and revocation propagation target.
- Event log used for replay and its ordering scope.
- Wake batching, quotas, overload policy, and tenant fairness defaults.
- Schema/version negotiation for typed metadata and frames.

## Falsifiable validation gates

1. Passivate an actor with active clients; sockets remain usable through the gateway and the next actor-directed frame wakes exactly the required identity.
2. Assert no command transaction, fiber, closure, or local timer is restored after activation loss.
3. Kill the gateway; clients disconnect, then resume or resync correctly without claiming socket immortality.
4. Race old and new transports for one logical connection; generation fencing prevents stale writes and duplicate subscriptions.
5. Replay duplicate inbound IDs with equal and changed payloads; equal requests dedupe and changed hashes conflict.
6. Expire and revoke auth while data is buffered; delivery pauses and no unauthorized row/event escapes after the policy epoch changes.
7. Reconnect a large fleet simultaneously; bounded admission and jitter prevent an unbounded actor wake storm.
8. Stall consumers and exhaust replay retention; memory stays bounded and clients receive disconnect/resync rather than silent loss.
9. Start a long model activity, passivate the actor, and disconnect the client; work continues independently and completion is recoverable by operation ID.

Passing these gates establishes the tested gateway topology and transports only. It does not establish arbitrary fiber checkpointing, immortal connections, or exactly-once network delivery.
