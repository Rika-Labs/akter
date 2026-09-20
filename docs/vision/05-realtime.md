# 05 — Realtime applications

## Vision

Realtime behavior belongs with the actor that owns the state. Developers should not need a separate synchronization product for every room, document, agent, or device.

An actor may provide:

- durable events;
- typed subscriptions;
- snapshot and cursor replay;
- presence;
- ephemeral signals;
- WebSocket connections;
- connection-preserving activation sleep;
- live SQL subscriptions where the query is supported.

## The continuity rule

Every committed change must appear in the initial snapshot or in replay after its cursor. If the runtime cannot prove continuity, it must request a resync instead of pretending the stream is complete.

## Durable versus ephemeral

| Durable              | Ephemeral              |
| -------------------- | ---------------------- |
| messages             | typing indicators      |
| events               | presence leases        |
| receipts             | token chunks           |
| subscription cursors | connection-local hints |

Realtime must never require keeping a database transaction or arbitrary actor fiber alive.
