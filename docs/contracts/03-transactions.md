# Transactions and commit

**Responsibility:** define atomic local facts.  
**Authority:** normative.  
**Owner role:** storage/runtime.  
**Change policy:** every adapter must run the same transaction conformance suite.

The command-turn transaction MUST atomically include the generation fence, receipt, state migration and dirty state, actor-owned business rows, durable events, timers, workflow intents, actor-message intents, and effect outbox rows used by that turn. A failed transaction MUST expose none of them.

External calls, WebSocket writes, `ctx.connections.broadcast`, streams, workflow execution, and effect execution MUST occur outside the transaction. `ctx.connections.broadcast` is best-effort and MUST NOT be described as transactional.

On ordinary Postgres, local intents MAY be inserted into `cluster_messages` in the turn transaction. On Neki, a cross-shard-group write MUST NOT be assumed atomic: the turn MUST write `actor_outbox` in the tenant shard, and a relay MUST move the intent to `cluster_messages` after COMMIT exactly once using the intent id.

Adapters MUST prove locking, connection pinning, rollback, and relay recovery through the gates in [conformance](../verification/01-conformance.md). SQL protocol compatibility alone is insufficient.
