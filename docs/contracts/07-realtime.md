# Realtime continuity

**Responsibility:** define subscriptions, replay, and connection behavior.  
**Authority:** normative.  
**Owner role:** realtime/runtime.  
**Change policy:** every transport must test snapshot/live race, loss, replay, and revocation.

Durable event subscriptions MUST use an event cursor and MUST preserve actor-stream order across replay and live delivery. Retention gaps MUST be explicit; clients MUST NOT be told that a feed is continuous when events can have been skipped.

`ctx.state` outside a command turn MUST be a committed `StateSnapshot` with `changes: Stream<State>`. Snapshot changes MUST publish only after commit.

Realtime sessions MUST be declared with `Actor.connection`. Connection state MUST be stored in `actor_connections`, scoped to tenant and actor, and limited to 16 KiB. With `Connections.park`, open sockets MUST NOT keep the activation resident: hibernation leaves sockets open, and an inbound frame or broadcast wakes the activation. A resumed handler MUST observe restored `ctx.conn.state` and `ctx.conn.resumed === true`.

`ctx.connections.broadcast` is best-effort and non-transactional. Durable delivery MUST use events or command intents instead. Verification is the **Connection park** gate plus realtime invariants in [invariants](../verification/invariants.md).
