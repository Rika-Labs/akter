# Transactions and commit

**Responsibility:** define atomic local facts.  
**Authority:** normative.  
**Owner role:** storage/runtime.  
**Change policy:** every adapter must run the same transaction conformance suite.

The command-turn transaction MUST atomically include the generation fence, receipt, state migration and dirty state, actor-owned business rows and database blob mutations, durable events, timers, workflow intents, actor-message intents, and effect outbox rows used by that turn. A failed transaction MUST expose none of them.

An unhandled declared failure is a committed failure receipt, not a failed outer transaction. All business work MUST roll back while the fence and failure receipt remain in that transaction. A savepoint may implement this boundary only if the backend proves the required behavior; staged state, snapshot notifications, and broadcast frames MUST also be discarded. Failure before the outer commit still removes both the receipt and all business consequences.

A turn batch MUST give each command the same atomicity as a lone turn: a declared failure removes only that command's staged consequences, later commands observe state without them, and a failed outer commit exposes none of the batch. A batch MUST NOT exceed its command cap, and a transaction MUST NOT hold more savepoints than that cap. See [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md).

External calls, WebSocket writes, streams, workflow execution, and effect execution MUST occur outside the transaction. A turn's `turn.broadcast` frames MUST be flushed only after commit and discarded on rollback. Broadcast remains best-effort: loss after commit is not recovered like a durable event, so it MUST NOT be described as transactional delivery.

On every backend, intents and timers MUST be written to `actor_outbox` in the actor's shard within the turn transaction. After COMMIT, the owning runner's relay MUST deliver each due intent as a direct command using the intent id as the command id, and delete the row only after the receiver's receipt commits. Receiver receipts deduplicate at-least-once delivery ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)). This is not an exactly-once external-effect guarantee.

Adapters MUST prove locking, connection pinning, rollback, and relay recovery through the gates in [conformance](../verification/01-conformance.md). SQL protocol compatibility alone is insufficient.
