# Transactions and commit

**Responsibility:** define atomic local facts.  
**Authority:** normative.  
**Owner role:** storage/runtime.  
**Change policy:** every adapter must run the same transaction conformance suite.

The command-turn transaction MUST atomically include the generation fence, receipt, state migration and dirty state, actor-owned business rows and database blob mutations, durable events, timers, workflow intents, actor-message intents, and effect outbox rows used by that turn. A failed transaction MUST expose none of them. Per [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md): a turn that emits an event also re-arms, in the same transaction, the resume timer of each owner workflow execution with a pending `waitFor` for that event's tag, and a workflow start turn writes its execution row, version markers, and resume timer.

An unhandled declared failure is a committed failure receipt, not a failed outer transaction. All business work MUST roll back while the fence and failure receipt remain in that transaction. A savepoint may implement this boundary only if the backend proves the required behavior; staged state, snapshot notifications, and broadcast frames MUST also be discarded. Failure before the outer commit still removes both the receipt and all business consequences.

A turn batch MUST give each command the same atomicity as a lone turn: a declared failure removes only that command's staged consequences, later commands observe state without them, and a failed outer commit exposes none of the batch. A batch MUST NOT exceed its command cap, and a transaction MUST NOT hold more savepoints than that cap. See [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md).

External calls, WebSocket writes, streams, workflow execution, and effect execution MUST occur outside the transaction. A turn's `turn.broadcast` frames MUST be flushed only after commit and discarded on rollback. Broadcast remains best-effort: loss after commit is not recovered like a durable event, so it MUST NOT be described as transactional delivery. A connection-session write after a connection handler is not a turn: it is one statement outside any turn transaction, fenced by the generation, and carries no receipt. Opening a connection runs a short framework transaction with the generation fence and the `actor_connections` insert, also without a receipt ([realtime](07-realtime.md)).

On every backend, intents and timers MUST be written to `actor_outbox` in the actor's shard within the turn transaction. After COMMIT, any runner's relay MAY claim a due row; a claim is a lease that makes the row not due until it ends, and it MUST NOT hold a transaction or row lock while the row is delivered. The claiming relay MUST deliver each claimed intent as a direct command using the intent id as the command id, and delete the row only after the receiver's receipt commits ([ADR 0021](../decisions/0021-multi-runner-relay-singleton-and-cron.md)). Receiver receipts deduplicate at-least-once delivery ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)). This is not an exactly-once external-effect guarantee. Effects performed in a turn are `actor_outbox` rows of kind `effect` written in the same transaction; their executors run only after COMMIT ([background work](08-background-work.md)).

An adapter that pipelines turn statements MUST prove that the server executes them in submission order within the transaction, and that a failed statement aborts every statement pipelined after it, so that the final `COMMIT` rolls back ([ADR 0020](../decisions/0020-two-round-trip-turn-pipeline.md)).

Adapters MUST prove locking, connection pinning, rollback, and relay recovery through the gates in [conformance](../verification/01-conformance.md). SQL protocol compatibility alone is insufficient.
