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

These are the F1–F4 rules:

- **F1:** one command turn has exactly one outer transaction and no user-controlled commit boundary.
- **F2:** a successful output or declared failure becomes observable only with its committed receipt.
- **F3:** work outside the turn is read-only; durable consequences are scheduled as intents or effects.
- **F4:** retryable framework failures become defects and redelivery of the same envelope; the activation restarts.

Deterministic defects—state exceeding `State.maxBytes`, state decode failure, or an internal command from a non-`System` caller—MUST roll back, return a `Die` to the caller, invoke `onDefect` with read-only `WakeContext`, and leave the actor resident. Declared failures MUST commit and replay from receipts. A transport timeout or disconnect MUST NOT cancel an admitted turn.

Verification: gates **Crash points**, **Intent rollback**, **Turn boundary at runtime**, and **State migration chain** in [conformance](../verification/01-conformance.md).
