# Receipts, retries, and identity

**Responsibility:** define duplicate and ambiguous command behavior.  
**Authority:** normative.  
**Owner role:** runtime/reliability.  
**Change policy:** retention changes require restore and external-effect review.

Every command MUST have a stable command id minted by the Effect handle or Promise client before delivery. Delivery retries MUST reuse it; `turn()` MUST NOT mint it.

Receipts MUST be keyed by tenant, actor identity, and command id and MUST bind the command name and payload hash. The same id and payload MUST replay the committed output or declared failure without running the handler. The same id with a different command or payload MUST fail with `ActorError` whose reason is `CommandConflict`.

Receipt insertion, handler consequences, and receipt completion MUST share the command-turn transaction. A crash after commit but before reply MUST recover by replaying the receipt. A crash before commit MUST leave no receipt or consequence and MUST permit redelivery.

Receipt retention defines the deduplication horizon and MUST be explicit. Framework retry guidance MUST use `ActorError.isRetryable` and `retryAfter`; declared failures MUST never be wrapped.

Verification: invariants R1–R3 in [invariants](../verification/invariants.md) and the before/after commit rows in [failure cases](../verification/02-failure-matrix.md).
