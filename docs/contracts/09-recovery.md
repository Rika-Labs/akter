# Failure and recovery

**Responsibility:** define behavior across crashes and restarts.  
**Authority:** normative.  
**Owner role:** reliability.  
**Change policy:** every new durable record needs a crash-point analysis.

Recovery MUST derive authority and consequences from durable rows, never process memory. Before-COMMIT failure MUST roll back the receipt, state, events, intents, and effects. An intent from such a turn MUST never be delivered. After-COMMIT reply loss MUST resolve through the receipt without re-running the handler; external result delivery remains subject to the access and expiry rules in [receipts](04-receipts.md). A crash after an effect executor succeeds but before its `onSuccess` route commits MUST leave the effect pending: if the result was not yet recorded, the executor runs again under the same effect id; if it was, the route is redelivered and its receipt deduplicates it ([background work](08-background-work.md)).

Retryable defects MUST restart the activation; an uncommitted command is not durable, and the caller's handle MUST retry it with the same command id. Committed intents MUST be recovered from `actor_outbox`. Deterministic defects MUST follow [command turn](02-command-turns.md) rules and leave the activation resident. Hibernation MUST discard activation-local values while preserving committed state, parked connections, and connection state.

After ungraceful runner loss in the expiry-based recovery path, a survivor MUST wait for the dead runner's lock to expire before acquiring ownership; stale generations MUST fail the database fence. A singleton's residency and background loop MUST move to one surviving runner. Its cron ticks are outbox rows that any surviving relay claims, and they are delivered once the singleton is resident again ([ADR 0021](../decisions/0021-multi-runner-relay-singleton-and-cron.md)). Tests MUST distinguish lock expiry from time until resumed service, including polling and activation. The `shardLockExpiration` recovery target remains gated, not a measured end-to-end availability guarantee.

Outbox recovery MUST resume undelivered `actor_outbox` rows using the original intent id, on any runner, once the dead relay's claim lease has ended. An effect attempt whose runner died keeps its unknown outcome (`ambiguous`) and is retried or dead-lettered by another runner after its lease. A crash after the receiver commits but before the sender's row is deleted MUST NOT repeat the receiver's transition; its receipt replays. Required evidence is listed in [failure cases](../verification/02-failure-matrix.md) and gates **Crash points**, **Intent rollback**, **In-process multi-runner**, **Outbox delivery**, and **Singleton uniqueness**.
