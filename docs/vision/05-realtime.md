# Realtime

The Effect client reads state, lists, and optional derived views as Streams over one `/rpc` group. WebSocket uses JSON; HTTP POST uses NDJSON so responses can stay live. A new stream begins with a full durable value and then patches or updated windows.

Presence uses `presence: Schema` in the contract, synchronous `connect` and `disconnect` handlers in `toLayer`, and scoped `client.join(value)`. Session authentication and actor access are rechecked; transport ownership does not grant new authority.

Events are live and non-persisted. They have no historical cursor, durable feed, or replay promise. Store facts in state or lists when reconnection must recover them. Action events wait for durability; job progress events publish immediately and can repeat on retry.

Owner movement ends continuity and a client resubscribes to a fresh full frame. Slow-consumer cleanup, general tenant addresses, and hosted edge continuity require explicit failure evidence before stronger promises.
