# Realtime: state, views, presence, events and `find`

Status: proposal (0.2), owned by ADR 0130; promoted when E4 (streams, presence and events) and E7 (`find`) failure evidence lands, each section with its milestone.

**Responsibility:** define what clients read and watch, when they see changes, how presence and events behave, and what `find` promises.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** realtime and runtime.  
**Change policy:** every change must be tested for the snapshot/live race, loss, owner move and revocation.

## Reading and watching

- Any caller that passes `access` (kind `state`, `list` or `view`) MAY read and watch an actor's state, its lists and its views.
- `handle.state`, a list's watched `range`, and every view MUST be streams whose first element is the full current value and whose later elements are JSON patches between consecutive values. A one-shot read is the first element.
- Every streamed value MUST derive from the shard's durable prefix (I2). Speculative state MUST NOT be streamed.
- A stream MUST NOT send a value equal (by the schema's equivalence) to the previous one.
- A client whose action completed MUST observe that action's effect on every later read or new stream of that actor (read-your-writes), and values of one stream MUST be monotonic in the actor's log order.
- A view MUST be a pure, synchronous function of durable state and its parameters.
- Reads MUST be served by the shard owner after its validity check ([actor authority](01-actor-authority.md)); a read MUST NOT activate an actor for write.

## Lag, loss and owner moves

- A stream whose consumer falls behind its bounded buffer MUST either replace the queued patches with one new full value or end with `SessionEnded { cause: "SlowConsumer", resync: true }`. It MUST NOT skip a patch silently.
- When the actor's shard moves, its streams MUST end with `SessionEnded { cause: "OwnerMoved", resync: true }`; a client that resubscribes MUST receive a full value first.

## Presence

- An actor whose contract declares `presence` MUST enable `handle.join(params)`, `connect` and `disconnect`. Acquiring `join` MUST run `connect` as a durable action with a fresh connection id in `ctx.connection`; releasing it MUST run `disconnect`. Both run as the session's caller.
- The shard MUST record open connections in its state. Every durable `connect` MUST be followed by exactly one durable `disconnect` for the same connection: on release, when the owner detects the session's loss, or when the next owner opens the shard and runs `disconnect` for every connection the previous owner recorded.

## Events

- An event emitted by an action MUST be published only after the action's segment is durable, to sessions subscribed at that moment. Events MUST NOT be stored or replayed; a session MUST NOT receive an event emitted before it subscribed.
- An event emitted by a job MUST be published when emitted. Such an event is not in the log, MAY be delivered again if the job body replays, and has no ordering relative to action events.
- There are no event cursors, durable feeds or retention gaps.

## Sessions and revocation

Session binding, reauthorization every `reauthorizeEvery` and revocation are defined in [security](10-security.md). On revocation, buffered frames MUST be discarded.

## `find`

- `X.find({ where, orderBy, limit })` MUST query every top-level scalar state field of one actor type (string, number, boolean, literal, branded scalar, `DateTime`) with equality and range conditions joined by conjunction, one `orderBy` field, and `limit` at most 1,000.
- String comparisons MUST use the first 64 bytes (UTF-8) of the value; values sharing that prefix compare equal and are ordered by actor id.
- `find` MUST return only actors of the caller's tenant (I8b) and MUST run `access` with kind `find` once.
- `find` MUST NOT be callable from an action.
- **Freshness.** Each shard's part of a result MUST reflect every action durable on that shard when its owner answered and nothing that was not durable. A caller whose action completed before it called `find` MUST see that action's effect. A result is not a snapshot across shards: different shards answer at different moments. Shards without an owner MUST be opened to answer.

## Verification

I2 for every streamed value and index entry; I8b for `find`; E4 client conformance (full value then patches, slow consumer, owner move, reauthorization, revocation) on Node and Bun; exactly one `disconnect` per durable `connect` after gateway and owner crashes; E7 index consistency after random actions, crashes and moves.
