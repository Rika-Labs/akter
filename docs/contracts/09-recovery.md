# Failure and recovery

**Responsibility:** define behavior across crashes and restarts.  
**Authority:** normative.  
**Owner role:** reliability.  
**Change policy:** every new durable record needs a crash-point analysis.

Recovery MUST derive authority and consequences from durable rows, never process memory. Before-COMMIT failure MUST roll back the receipt, state, events, intents, and effects. An intent from such a turn MUST never be delivered. After-COMMIT reply loss MUST resolve through the receipt without re-running the handler; external result delivery remains subject to the access and expiry rules in [receipts](04-receipts.md).

Retryable defects MUST restart the activation and redeliver the same envelope. Deterministic defects MUST follow [command turn](02-command-turns.md) rules and leave the activation resident. Hibernation MUST discard activation-local `vars` while preserving committed state, parked connections, and connection state.

After ungraceful runner loss in the expiry-based recovery path, a survivor MUST wait for the dead runner's lock to expire before acquiring ownership; stale generations MUST fail the database fence. A singleton's residency, `run`, and cron responsibility MUST move to one surviving runner. Tests MUST distinguish lock expiry from time until resumed service, including polling and activation. The `shardLockExpiration` recovery target remains gated, not a measured end-to-end availability guarantee.

Neki relay recovery MUST resume unrelayed `actor_outbox` rows using the original intent id. A crash after destination insertion but before source acknowledgment MUST not create a second logical intent or repeat a retained receiver transition. Required evidence is listed in [failure cases](../verification/02-failure-matrix.md) and gates **Crash points**, **Intent rollback**, **In-process multi-runner**, **Neki intent relay**, and **Singleton uniqueness**.
