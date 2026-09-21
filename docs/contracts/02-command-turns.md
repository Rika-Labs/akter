# Command turns

**Responsibility:** define command admission and execution.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** update the failure matrix and receipt contract with every lifecycle change.

Every command attempt MUST execute as one framework-owned transaction, in this order:

1. lock and validate the generation fence;
2. insert or resolve the receipt for the caller-minted command id;
3. decode stored `actor_state` through the declared migration chain;
4. run the handler;
5. persist dirty state, owned rows, events, intents, effects, and the receipt result;
6. commit once.

The foundation labels retain their meaning from the agreed design:

- **F1:** one relational database per deployment, not per actor or tenant.
- **F2:** Effect Cluster provides one entity per actor type with serialized command handling (`concurrency: 1`).
- **F3:** commands are persisted with `WithTransaction: false` and no Cluster `primaryKey`; the framework owns the transaction above, rather than nesting the turn inside a Cluster transaction.
- **F4:** stale generations, lock timeouts, commit-unknown outcomes, and command execution timeouts follow the retryable-defect path; Cluster restarts the activation and redelivers the same envelope.

A successful output or declared failure MUST become observable only with its committed receipt. Off-turn contexts MUST NOT directly mutate durable actor data. The gated Neki storage arrangement is foundation F5, described in [storage layout](../architecture/03-storage-layout.md).

Deterministic defects—state exceeding `State.maxBytes`, state decode failure, or an internal command from a non-`System` caller—MUST roll back, return a `Die` to the caller, invoke `onDefect` with read-only `WakeContext`, and leave the actor resident. Declared failures MUST commit and replay from receipts. A transport timeout or disconnect MUST NOT cancel an admitted turn.

Terminal declared-error receipt persistence must be specified and failure-tested before implementation is claimed: recording a typed failure must not accidentally turn it into retryable redelivery, and catching it must not silently choose whether preceding writes commit. A caller's `Delivery.timeout` stops waiting and is distinct from a command execution timeout inside the turn.

Verification: gates **Crash points**, **Intent rollback**, **Turn boundary at runtime**, and **State migration chain** in [conformance](../verification/01-conformance.md).
