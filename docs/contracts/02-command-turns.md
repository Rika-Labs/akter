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

Commands already waiting for the same actor MAY share one transaction as a turn batch under [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md). Each command in a batch MUST keep its own receipt, output, and declared-failure isolation; a defect MUST abort the batch, and its commands MUST then execute one per transaction until the failing command is processed. The next batch MAY execute in memory while the previous batch commits, but no reply, broadcast, or intent from a batch MAY become visible before that batch commits. The runtime MUST NOT delay a lone command to form a batch.

Resolving a retained receipt skips state migration and handler execution. External receipt delivery still requires current receipt-access authorization; a denied caller MUST NOT fall through to a new execution.

The foundation labels retain their meaning from the agreed design:

- **F1:** one relational database per deployment region, not per actor or tenant; a single-region deployment has exactly one ([ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md)).
- **F2:** Effect Cluster provides one entity per actor type with serialized command handling (`concurrency: 1`).
- **F3:** commands are direct: routed to the owner as volatile Cluster messages, admitted by the receipt inside the turn transaction, and retried by the caller with the same command id. Durable intents and timers use the actor-shard outbox ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md); this replaced persisted Cluster command messages).
- **F4:** stale generations, lock timeouts, commit-unknown outcomes, and command execution timeouts follow the retryable-defect path; the activation restarts and the caller's handle retries the same command id.

A successful output or declared failure MUST become observable only with its committed receipt. Off-turn contexts MUST NOT directly mutate durable actor data. The gated Neki storage arrangement is foundation F5, amended by ADR 0011 (no `cluster_*` intent handoff), described in [storage layout](../architecture/03-storage-layout.md).

Deterministic defects—state exceeding `policy.maxStateBytes`, state decode failure, or an internal command from a non-`System` caller—MUST roll back, return a `Die` to the caller, record the cause in the turn span and log, run no user code, and leave the actor resident ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)). Declared-failure receipts MUST commit and replay without retaining business changes. A transport timeout or disconnect MUST NOT cancel an admitted turn.

An unhandled declared failure MUST discard state migration writes, dirty state, owned rows, blobs, events, timers, actor/workflow intents, effect obligations, and staged snapshot/broadcast notifications. The generation fence and terminal failure receipt MUST remain in the same framework-owned transaction; a second transaction for the receipt is not permitted. A failure caught by application code followed by a successful handler result commits normally. Intentional durable rejection is an output-schema value, not a commit-on-error policy. Activation-local values in a layer's build closure are not automatically rolled back. See [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md).

A caller's `policy.deliveryTimeout` stops waiting and is distinct from a command execution timeout inside the turn. Receipt persistence and business rollback still require failure tests before implementation is claimed.

## Implemented turn semantics (second foundation slice)

[ADR 0008](../decisions/0008-foundation-completion.md) binds the following to the current M0 implementation, which still persists commands as Cluster messages and uses the M0 API spelling. [ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md) changes redelivery to caller retry, and [ADR 0010](../decisions/0010-one-way-effect-native-api.md) changes the spelling; both apply when M1 migrates this code.

- **Creation check.** When `Lifecycle.createdBy` is declared, the turn resolves the receipt first, then checks the `created` marker (migration `0002_creation`, default `false`) under the generation lock. A non-creating command on an uncreated actor fails `NotCreated` without writing a receipt; a failed creating turn keeps its error receipt and stays uncreated; the first successful creating command sets `created` in the same commit as state and receipt. Successful commands without a creation policy do not set the marker.
- **Bounded execution.** `Commands.timeout` bounds the whole transaction interruptibly — interruption rolls back and dies `RetryTurn` — and sets transaction-local `statement_timeout`; `Commands.lockWait` sets transaction-local `lock_timeout`. `RetryTurn` and retryable `SqlError` causes restart the activation and redeliver the same envelope. An uncertain commit never resolves to a terminal success or failure.
- **Deterministic defects.** No receipt is written. `onDefect` receives `WakeContext` with `ref` and a lazy read-only `state` effect — the hook is invoked even when that read would die on corrupt state. The hook is interruptible, bounded by the execution deadline, and its failure reports an `AggregateError` containing the original cause. The caller observes `Die`; the activation stays resident.
- **Delivery timeout.** After command identity acquisition, `Delivery.timeout` bounds admission, receipt reads, and the caller's reply wait. A message already handed to the runtime continues, and its receipt remains resolvable by an authorized original caller within the retry horizon. Timing out before admission does not imply acceptance.
- **Internal commands.** A non-`System` caller reaching an internal command is a deterministic defect, not an `ActorError`.

Verification: gates **Crash points**, **Intent rollback**, **Turn boundary at runtime**, and **State migration chain** in [conformance](../verification/01-conformance.md).
