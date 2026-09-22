# Transactions and commit

**Responsibility:** define atomic local facts.  
**Authority:** normative.  
**Owner role:** storage/runtime.  
**Change policy:** every adapter must run the same transaction conformance suite.

The command-turn transaction MUST atomically include the generation fence, receipt, state migration and dirty state, actor-owned business rows and database blob mutations, durable events, timers, workflow intents, actor-message intents, and effect outbox rows used by that turn. A failed transaction MUST expose none of them.

An unhandled declared failure is a committed failure receipt, not a failed outer transaction. All business work MUST roll back while the fence and failure receipt remain in that transaction. A savepoint may implement this boundary only if the backend proves the required behavior; staged state, snapshot notifications, and broadcast frames MUST also be discarded. Failure before the outer commit still removes both the receipt and all business consequences.

External calls, WebSocket writes, streams, workflow execution, and effect execution MUST occur outside the transaction. A turn's `ctx.connections.broadcast` frames MUST be flushed only after commit and discarded on rollback. Broadcast remains best-effort: loss after commit is not recovered like a durable event, so it MUST NOT be described as transactional delivery.

On ordinary Postgres, local intents MAY be inserted into `cluster_messages` in the turn transaction through the same transaction-bound `SqlClient`. On Neki, the turn MUST write `actor_outbox` in the tenant shard, and a relay MUST transfer the intent to `cluster_messages` after COMMIT using its stable intent id. Retrying the handoff MUST create only one logical destination intent; receiver receipts deduplicate at-least-once delivery. This is not an exactly-once external-effect guarantee.

Adapters MUST prove locking, connection pinning, rollback, and relay recovery through the gates in [conformance](../verification/01-conformance.md). SQL protocol compatibility alone is insufficient.
