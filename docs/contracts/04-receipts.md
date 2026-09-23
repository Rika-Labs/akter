# Receipts, retries, and identity

**Responsibility:** define duplicate and ambiguous command behavior.  
**Authority:** normative.  
**Owner role:** runtime/reliability.  
**Change policy:** retention changes require restore and external-effect review.

Every command MUST have a stable command id minted by the Effect handle or Promise client before delivery. Delivery retries MUST reuse it; `turn()` MUST NOT mint it.

Receipts MUST be keyed by tenant, actor identity, and command id and MUST bind the command name and payload hash. Within the external retry horizon and subject to receipt-access authorization, the same id and payload MUST replay the committed output or declared failure without running the handler. Within that horizon, an authorized retry with the same id but a different command or payload MUST fail with `ActorError` whose reason is `CommandConflict`.

Stored outcomes MUST be accessible only to the original logical caller with current resource/operation authorization, or an operator explicitly authorized for that receipt. Credential rotation MUST NOT change logical caller identity. Receipt access MUST be checked without rerunning the handler. A different caller presenting the same id MUST neither receive the stored outcome nor cause another execution; caller identity MUST NOT become an additional deduplication key. See the [authorization model](../security/authorization-model.md).

Receipt insertion, handler consequences, and receipt completion MUST share the command-turn transaction. A crash after commit but before reply MUST recover through the receipt, with external replay subject to access and expiry checks. A crash before commit MUST leave no receipt or consequence and MUST permit internal redelivery of accepted work.

For an unhandled declared failure, business changes MUST roll back before the terminal error receipt commits in that same transaction. A retained failure replays even if business conditions later change; reevaluating the operation requires a new command id. Failure receipts MUST NOT turn a terminal application error into retryable handler redelivery.

External retry and receipt-retention horizons MUST be finite, configurable, and explicit. External deliveries with expired command identities MUST be rejected without invoking the handler, even after receipt cleanup. An absent receipt MUST NOT be treated as proof that an expired identity is new. The identity/admission protocol MUST make expiry enforceable after pruning, restart, and supported restore; expiry metadata MUST NOT be refreshable independently of command identity. [ADR 0007](../decisions/0007-foundation-command-protocol.md) specifies the embedded v1 clock, boundary, caller, and error rules. Its first implementation has no automatic pruning or supported restore, so those portions of this contract remain unimplemented.

Expiry MUST NOT cancel accepted durable work or reject its trusted internal redelivery. Cleanup MUST preserve the deduplication evidence needed by pending messages and recovery obligations, and MUST NOT race with admission into duplicate execution. See [retention](../operations/retention.md) and [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).

Framework retry guidance MUST use `ActorError.isRetryable` and `retryAfter`; declared failures MUST never be wrapped. Expiry MUST NOT trigger an automatic retry with a new id: a fresh id is an explicit new operation and does not resolve the old outcome. Concrete expiry and receipt-access-denial mappings require the compatibility design noted in the [error model](error-model.md).

Verification: invariants R1–R5 in [invariants](../verification/invariants.md) and the receipt-access, expiry, and before/after commit rows in [failure cases](../verification/02-failure-matrix.md).
