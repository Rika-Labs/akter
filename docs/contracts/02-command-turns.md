# Command turns

**Responsibility:** define command admission and execution.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** update the failure matrix and receipt contract with every lifecycle change.

External admission MUST check current authorization and command expiry under the [receipt contract](04-receipts.md). Trusted internal redelivery of accepted work remains recoverable after originating-caller revocation or external retry expiry.

Every admitted command attempt MUST execute within one framework-owned transaction, in this order:

1. lock and validate the generation fence;
2. insert or resolve the receipt for the caller-minted command id;
3. decode stored `actor_state` through the declared migration chain, or reuse the activation's decoded copy when the fence proves the generation unchanged;
4. run the handler;
5. on success, persist business consequences and the receipt result; on an unhandled declared failure, roll back business work and persist only the failure outcome in the receipt;
6. commit once.

Commands already waiting for the same actor MAY share one transaction as a turn batch under [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md). Each command in a batch MUST keep its own receipt, output, and declared-failure isolation; a defect MUST abort the batch and redeliver its commands one per transaction until the failing command is processed. The runtime MUST NOT delay a lone command to form a batch.

Resolving a retained receipt skips state migration and handler execution. External receipt delivery still requires current receipt-access authorization; a denied caller MUST NOT fall through to a new execution.

The foundation labels retain their meaning from the agreed design:

- **F1:** one relational database per deployment region, not per actor or tenant; a single-region deployment has exactly one ([ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md)).
- **F2:** Effect Cluster provides one entity per actor type with serialized command handling (`concurrency: 1`).
- **F3:** commands are persisted with `WithTransaction: false` and no Cluster `primaryKey`; the framework owns the transaction above, rather than nesting the turn inside a Cluster transaction.
- **F4:** stale generations, lock timeouts, commit-unknown outcomes, and command execution timeouts follow the retryable-defect path; Cluster restarts the activation and redelivers the same envelope.

A successful output or declared failure MUST become observable only with its committed receipt. Off-turn contexts MUST NOT directly mutate durable actor data. The gated Neki storage arrangement is foundation F5, described in [storage layout](../architecture/03-storage-layout.md).

Deterministic defects—state exceeding `State.maxBytes`, state decode failure, or an internal command from a non-`System` caller—MUST roll back, return a `Die` to the caller, invoke `onDefect` with read-only `WakeContext`, and leave the actor resident. Declared-failure receipts MUST commit and replay without retaining business changes. A transport timeout or disconnect MUST NOT cancel an admitted turn.

An unhandled declared failure MUST discard state migration writes, dirty state, owned rows, blobs, events, timers, actor/workflow intents, effect obligations, and staged snapshot/broadcast notifications. The generation fence and terminal failure receipt MUST remain in the same framework-owned transaction; a second transaction for the receipt is not permitted. A failure caught by application code followed by a successful handler result commits normally. Intentional durable rejection is an output-schema value, not a commit-on-error policy. Activation-local `vars` are not automatically rolled back. See [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md).

A caller's `Delivery.timeout` stops waiting and is distinct from a command execution timeout inside the turn. Receipt persistence and business rollback still require failure tests before implementation is claimed.

Verification: gates **Crash points**, **Intent rollback**, **Turn boundary at runtime**, and **State migration chain** in [conformance](../verification/01-conformance.md).
