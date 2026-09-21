# Failure and recovery

**Responsibility:** define behavior across crashes and restarts.  
**Authority:** normative.  
**Owner role:** reliability.  
**Change policy:** every new durable record needs a crash-point analysis.

Recovery MUST derive authority and consequences from durable rows, never process memory. Before-COMMIT failure MUST roll back the receipt, state, events, intents, and effects. An intent from such a turn MUST never be delivered. After-COMMIT reply loss MUST replay the receipt without re-running the handler.

Retryable defects MUST restart the activation and redeliver the same envelope. Deterministic defects MUST follow [command turn](02-command-turns.md) rules and leave the activation resident. Hibernation MUST discard activation-local `vars` while preserving committed state, parked connections, and connection state.

After runner death, shard ownership MUST move only after `shardLockExpiration`; stale generations MUST fail the database fence. A singleton's residency, `run`, and cron responsibility MUST move to exactly one surviving runner within that interval.

Neki relay recovery MUST resume unrelayed `actor_outbox` rows and move each intent exactly once. Required evidence is listed in [failure cases](../verification/02-failure-matrix.md) and gates **Crash points**, **Intent rollback**, **In-process multi-runner**, **Neki intent relay**, and **Singleton uniqueness**.
