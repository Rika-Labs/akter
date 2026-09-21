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

A stale generation, lock timeout, commit-unknown result, or delivery timeout is a retryable defect: the activation restarts and Cluster redelivers. An old writer may continue computing, but the generation fence prevents its commit. Deterministic defects roll back and follow the `onDefect` path described in [lifecycle](02-lifecycle.md).

Nothing staged by a handler is visible when the turn fails before commit. In particular, an intent is never delivered after a failed turn. On Neki, a committed `actor_outbox` row is relayed after commit and deduplicated by intent receipt.

Client-minted command ids remain stable across retries. Reusing an id with different input produces `ActorError` with reason `CommandConflict`; replaying the same input returns the stored receipt.

Singleton registration guarantees one `run` owner and one cluster-wide cron tick across runners. Named and minted cron policies use per-actor durable timers.
