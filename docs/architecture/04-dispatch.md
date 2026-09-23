# Dispatch and fencing

**Responsibility:** describe how work reaches one current actor generation.  
**Authority:** design.  
**Owner role:** runtime/reliability.
**Change policy:** a change that alters a contract guarantee requires an ADR.

Effect Cluster sharding routes a volatile command message to the current activation, but durable storage is the authority. The receipt committed inside the turn is the command's only durable admission record. External admission checks current authorization and command expiry; trusted recovery of already accepted work retains its durable authority. A command turn follows one order:

1. begin the transaction and set tenant scope;
2. `SELECT ... FOR UPDATE` the actor generation row;
3. resolve the command receipt under the [receipt contract](../contracts/04-receipts.md), replaying a matching outcome only through the appropriate caller-access or trusted-recovery path;
4. decode state through migrations, or reuse the activation's decoded copy from the same generation, and run the handler;
5. stage state, actor-table changes, events, intents, effects, and the receipt;
6. commit once, then notify delivery.

The framework pipelines steps 1–3 into one admission round trip and steps 5–6 into one commit round trip; handler-issued `turn.rows` statements are the only other round trips. The activation consumes its mailbox with `Entity.toLayerQueue`. When more commands for the actor are already waiting, it runs them as a turn batch in delivery order: one admission round trip resolves every receipt, handlers run in sequence, and one commit round trip persists all outcomes. While batch N commits, batch N+1's handlers run in memory against batch N's staged state; replies, broadcasts, and outbox visibility follow each commit. A lone command is never delayed to form a batch. A defect or failed commit restarts the activation; uncommitted commands are retried by their callers, one per transaction until the failing command is processed. See [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md).

A stale generation, lock timeout, commit-unknown result, or command execution timeout is a retryable defect: the activation restarts and the caller's handle retries the same command id. A caller's delivery timeout instead stops waiting and may return `ActorError` with reason `Timeout`; it does not cancel the admitted turn. An old writer may continue computing, but the generation fence prevents its commit. Deterministic defects roll back and follow the `onDefect` path described in [lifecycle](02-lifecycle.md).

Commands use volatile Cluster messages (`Persisted: false`), no Cluster `primaryKey`, and serialized entity handling ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)). The framework owns deduplication through receipts and owns the only turn transaction; no reply is sent before commit.

Nothing staged by a handler is visible when the turn fails before commit. In particular, an intent is never delivered after a failed turn. A committed `actor_outbox` row is delivered after commit as a direct command and deduplicated by the receiver's receipt.

Client-minted command ids remain stable across retries. An authorized retry within the external retry horizon with different input produces `ActorError` with reason `CommandConflict`; the same input returns the stored receipt. Receipt access checks run without the handler. A caller mismatch or expired external identity must not fall through to a new handler execution, even after cleanup. The concrete identity/expiry protocol remains to be specified; see [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).

Singleton registration guarantees one live activation (and so one background loop) and one cluster-wide cron tick across runners. Cron on named and minted actors uses per-actor outbox timers.

Timers are keyed outbox rows: `Intent.key` replaces an earlier pending timer with the same key, and `Intent.cancel` deletes it in the turn transaction. Durable polling remains the correctness path. Post-commit wakeups travel as local or runner-to-runner messages through Cluster routing; missed wakeups must not lose work. Postgres `LISTEN/NOTIFY` is not used on the turn or wake path, because committing a `NOTIFY` can serialize the whole database. Due outbox rows (intents and timers) are scanned by `(bucket, due_at)` over the `routing_key` buckets a runner owns, so scan cost follows due work rather than stored actors. See [ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md).
