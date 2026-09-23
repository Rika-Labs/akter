# Realtime continuity

**Responsibility:** define subscriptions, replay, and connection behavior.  
**Authority:** normative.  
**Owner role:** realtime/runtime.  
**Change policy:** every transport must test snapshot/live race, loss, replay, and revocation.

Durable event subscriptions MUST use an event cursor and MUST preserve actor-stream order across replay and live delivery. Retention gaps MUST be explicit; clients MUST NOT be told that a feed is continuous when events can have been skipped.

`X.Read` and `X.Connection` MUST expose committed state only. Committed state changes MUST publish only after commit, and browser handles MUST receive them to reconcile optimistic reducers. Workflow bodies and effect executors do not receive direct actor-state access.

`Actor.stream` is live and non-persisted; it ends with the activation and does not promise replay. Durable output uses `events(Event, { after })`, whose cursor is exclusive, and yields the committed event with its sequence, timestamp, and command id.

Realtime sessions MUST be declared with `Actor.connection`. Connection state MUST be stored in `actor_connections`, scoped to tenant and actor, and limited to 16 KiB. With `policy.connections: "park"` (the default), open sockets MUST NOT keep the activation resident: hibernation leaves sockets open, and an inbound frame or broadcast wakes the activation. A resumed handler MUST observe restored connection `state` and `resumed === true` on `X.Connection`.

`broadcast` is best-effort and non-transactional. Durable delivery MUST use events or command intents instead. Verification is the **Connection park** gate plus realtime invariants in [invariants](../verification/invariants.md).

Parking preserves a socket across activation hibernation, not across the death of the process holding that socket. Transport loss requires reconnect and, for durable output, event replay. Authorization applies to replay and live delivery; slow consumers and retention gaps require explicit resync or disconnect behavior rather than silent loss.

Connections and subscriptions MUST reauthorize or disconnect within a documented revocation bound. Parking, resumption, reconnect, and event replay MUST NOT extend stale access indefinitely. Losing session access does not cancel previously accepted durable work; that requires explicit cancellation under the [security contract](10-security.md).

Ephemeral high-frequency data, such as cursors and typing indicators, MUST travel as connection frames rather than commands; there is no lower-durability command mode.
