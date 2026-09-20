# Realtime continuity

**Responsibility:** define subscriptions, replay, and connection behavior.  
**Authority:** normative.  
**Owner role:** realtime/runtime.  
**Change policy:** every transport must test snapshot/live race, loss, replay, and revocation.

A subscription starts with an authorized snapshot and a cursor boundary. Changes after that boundary are delivered in order for the stream's declared scope. If the boundary cannot be maintained, the server sends `resync-required`.

Presence and signals are ephemeral. Durable events and state changes are replayable according to retention. Slow consumers are bounded by explicit buffering, resync, or disconnect behavior.

Authorization applies to snapshot, replay, live delivery, and publish. Revocation must not allow buffered unauthorized data past the declared enforcement boundary.
