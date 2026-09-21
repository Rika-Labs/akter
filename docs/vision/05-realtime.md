# 05 — Realtime applications

**Responsibility:** define realtime continuity and live behavior.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Realtime behavior belongs with the actor that owns the state. Rooms, documents, devices, and agents should not need a separate synchronization model beside their commands and relational data.

An actor may expose:

- durable events ordered by a cursor;
- live, non-persisted streams that restart rather than replay after disconnect;
- typed `Actor.connection` contracts over WebSocket transport;
- per-connection state that survives connection parking;
- presence and best-effort broadcast;
- committed state snapshots through `ctx.state.changes`.

## Continuity

A client establishes a snapshot and cursor, then follows events after that cursor. Durable events are the recovery path after disconnects, slow consumers, or process loss. If retention has removed required history, the system must say that resynchronization is required.

`Connections.park` is the default hibernation policy: sockets remain parked while the actor activation sleeps. An inbound frame or relevant broadcast wakes the activation and restores connection state. `Connections.keepAwake` is available when residency is intentional.

Parking does not preserve sockets across transport-process death. Clients reconnect after transport loss, and durable event feeds resume with the exclusive `after` cursor. `Actor.stream` has no durable replay guarantee.

## Durable versus live

| Durable                         | Live and best-effort                |
| ------------------------------- | ----------------------------------- |
| committed actor events          | broadcasts                          |
| event cursors                   | typing indicators                   |
| receipts                        | presence hints                      |
| keyed state and OwnedTable rows | token chunks that are not persisted |

`ctx.connections.broadcast` is best-effort transport, not a durable transaction consequence. When requested by a command, frames are queued until after commit and discarded on rollback; a later transport failure can still lose them. Durable facts must be emitted as events or written as state. Realtime must never require holding a database transaction open for the lifetime of a stream or connection.

See [durable execution](04-durable-execution.md) for commit semantics.
