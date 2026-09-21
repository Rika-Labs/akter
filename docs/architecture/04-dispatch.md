# Dispatch and fencing

**Responsibility:** describe how work reaches one current actor generation.  
**Authority:** design.  
**Owner role:** runtime/reliability.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Effect Cluster sharding routes an envelope to the current activation, but durable storage is the authority. A command turn follows one order:

1. begin the transaction and set tenant scope;
2. `SELECT ... FOR UPDATE` the actor generation row;
3. look up the command receipt and replay it when it matches;
4. decode state through migrations and run the handler;
5. stage state, actor-table changes, events, intents, effects, and the receipt;
6. commit once, then notify delivery.

A stale generation, lock timeout, commit-unknown result, or command execution timeout is a retryable defect: the activation restarts and Cluster redelivers. A caller's delivery timeout instead stops waiting and may return `ActorError` with reason `Timeout`; it does not cancel the admitted turn. An old writer may continue computing, but the generation fence prevents its commit. Deterministic defects roll back and follow the `onDefect` path described in [lifecycle](02-lifecycle.md).

Commands use persisted Cluster messages, `WithTransaction: false`, no Cluster `primaryKey`, and serialized entity handling. The framework owns deduplication through receipts and owns the only turn transaction; a Cluster-managed outer transaction must not let reply listeners observe a result before commit.

Nothing staged by a handler is visible when the turn fails before commit. In particular, an intent is never delivered after a failed turn. On Neki, a committed `actor_outbox` row is relayed after commit and deduplicated by intent receipt.

Client-minted command ids remain stable across retries. Reusing an id with different input produces `ActorError` with reason `CommandConflict`; replaying the same input returns the stored receipt.

Singleton registration guarantees one `run` owner and one cluster-wide cron tick across runners. Named and minted cron policies use per-actor durable timers.

Timer keys replace earlier scheduled intents; cancellation or replacement tombstones the previous message so a late delivery is ignored. Durable polling remains the correctness path. Local wakeups and Postgres `NOTIFY actor_wake` after commit may reduce latency, but missed notifications must not lose work and Neki must not depend on `LISTEN/NOTIFY` support.
