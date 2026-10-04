# Command turns

**Responsibility:** define command admission and execution.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** update the failure matrix and receipt contract with every lifecycle change.

External admission MUST check current authorization and command expiry under the [receipt contract](04-receipts.md). Trusted internal redelivery of accepted work remains recoverable after originating-caller revocation or external retry expiry.

A runner MAY refuse overload before durable admission. Such a refusal MUST run no handler and write no receipt, MUST be retryable `ActorUnavailable` with a retry delay, and MUST preserve the caller's command identity on retry. Accepted turns retain every transaction and receipt guarantee below. A caller stopping its wait MUST NOT free the executing attempt's admission slot or cancel its turn. The runtime's bounded command queue and each storage checkout queue are transient scheduling controls, never durable authority.

Concurrent actor, query, and job layer registration MUST retry a pre-statement pool checkout refusal with backoff instead of converting it into a startup defect. Registration MUST still reject incompatible placement, tables, workflows, and payload versions; it MUST NOT retry statement failures or unknown commit outcomes as checkout refusals. This startup retry does not change external command overload responses.

Authorization precedes delivery. The first external delivery MAY validate command expiry and resolve a replay in the turn's fenced admission read instead of an off-turn receipt read. That admission clock MUST be read after any wait to acquire the generation fence. The expiry recheck before result delivery MAY use a database clock read on the turn's session after `COMMIT` or `ROLLBACK`, in the same flight; it MUST NOT use the admission clock ([ADR 0072](../decisions/0072-served-command-in-two-round-trips.md)).

Every admitted command attempt MUST execute within one framework-owned transaction, in this order:

1. lock and validate the generation fence;
2. insert or resolve the receipt for the caller-minted command id;
3. decode stored `actor_state` through the declared migration chain, or reuse the activation's decoded copy when the fence proves the generation unchanged;
4. run the handler;
5. on success, persist business consequences and the receipt result; on an unhandled declared failure, roll back business work and persist only the failure outcome in the receipt;
6. commit once.

This order is the order in which the database executes the statements inside the transaction. The runtime MAY pipeline statements, sending a group without waiting for each reply, when the server preserves their order. The handler MUST NOT run before the fence and receipt replies have been validated. A runtime that pipelines MUST cancel and close the connection of a turn interrupted with a pipeline in flight, and MUST NOT reuse it. If `COMMIT` was already sent, the outcome is commit-unknown and resolves through the receipt (F4). See [ADR 0020](../decisions/0020-two-round-trip-turn-pipeline.md).

Commands already waiting for the same actor MAY share one transaction as a turn batch under [ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md). Each command in a batch MUST keep its own receipt, success value, and declared-failure isolation; a defect MUST abort the batch, and its commands MUST then execute one per transaction until the failing command is processed. The next batch MAY send its admission statements while the previous batch commits, but its handlers MUST NOT run until its own fence and receipts are validated ([ADR 0020](../decisions/0020-two-round-trip-turn-pipeline.md)), and no reply, broadcast, or intent from a batch MAY become visible before that batch commits. If the previous batch fails to commit, the next batch's transaction MUST roll back without running a handler, and the callers of both retry. The runtime MUST NOT delay a lone command to form a batch.

A reducer call is a command turn whose handler step is the declared pure `reduce(state, payload)`; it has the same admission, receipt, conflict, replay, and declared-failure rules as a command. A throwing `reduce` or a returned state the schema rejects is a deterministic defect.

Resolving a retained receipt skips state migration and handler execution. External receipt delivery still requires current receipt-access authorization; a denied caller MUST NOT fall through to a new execution.

The foundation labels retain their meaning from the agreed design:

- **F1:** one relational database per deployment region, not per actor or tenant; a single-region deployment has exactly one ([ADR 0005](../decisions/0005-turn-latency-batching-and-regional-placement.md)).
- **F2:** Effect Cluster provides one entity per actor type with serialized command handling (`concurrency: 1`).
- **F3:** commands are direct: routed to the owner as volatile Cluster messages, admitted by the receipt inside the turn transaction, and retried by the caller with the same command id. Durable intents and timers use the actor-shard outbox ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md); this replaced persisted Cluster command messages).
- **F4:** stale generations, lock timeouts, commit-unknown outcomes, lost database connections, and command execution timeouts are retryable turn failures: the activation restarts and answers `ActorUnavailable`, and the caller's handle retries the same command id.

A success value or declared failure MUST become observable only with its committed receipt. Off-turn contexts MUST NOT directly mutate durable actor data. `actor_connections` is session data, not actor data: its writers are listed and fenced in [ADR 0023](../decisions/0023-connections-parking-and-streams.md), and the one written outside a turn is the connection-session update after a connection handler ([realtime](07-realtime.md)).

A Postgres batch with no chained admission MUST return its turn session before publishing results. It MUST first receive the transaction-ending reply and every outstanding statement reply; no open transaction or in-flight statement may be returned to the pool. A batch whose successor's admission was pipelined behind its commit keeps that session until the chain ends. Interrupted pool waiters MUST neither consume a slot nor prevent a later waiter from acquiring it ([ADR 0071](../decisions/0071-fair-pools-query-pool-and-early-turn-release.md)).

Deterministic defects—state exceeding `policy.maxStateBytes`, events emitted in one turn exceeding the 1 MiB emit budget, blob writes past `policy.maxBlobBytes` or `policy.maxBlobEntries`, state decode failure, or an internal command from a non-`System` caller—MUST roll back, return a `Die` to the caller, record the cause in the turn span and log, run no user code, and leave the actor resident ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)). Declared-failure receipts MUST commit and replay without retaining business changes. A transport timeout or disconnect MUST NOT cancel an admitted turn.

An unhandled declared failure MUST discard state migration writes, dirty state, owned rows, blobs, events, timers, actor/workflow intents, job obligations, and staged snapshot/broadcast notifications. The generation fence and terminal failure receipt MUST remain in the same framework-owned transaction; a second transaction for the receipt is not permitted. A failure caught by application code followed by a successful handler result commits normally. Intentional durable rejection is a `success`-schema value, not a commit-on-error policy. Activation-local values in a layer's build closure are not automatically rolled back. See [ADR 0003](../decisions/0003-failure-scoping-drain-and-hosted-trust.md).

A caller's `policy.deliveryTimeout` stops waiting and is distinct from a command execution timeout inside the turn. Receipt persistence and business rollback still require failure tests before implementation is claimed.

## Implemented turn semantics

[ADR 0008](../decisions/0008-foundation-completion.md), as amended by [ADR 0013](../decisions/0013-m0-reconciliation.md), binds the following to the current implementation:

- **Creation check.** When `createdBy` is declared, the turn resolves the receipt first, then checks the `created` marker (migration `0002_creation`, default `false`) under the generation lock. A non-creating command on an uncreated actor fails `NotCreated` without writing a receipt; a failed creating turn keeps its error receipt and stays uncreated; the first successful creating command sets `created` in the same commit as state and receipt. Successful commands without a creation policy do not set the marker.
- **Bounded execution.** `policy.executionTimeout` bounds the whole transaction interruptibly — interruption rolls back and dies `RetryTurn` — and sets transaction-local `statement_timeout`; `policy.lockWait` sets transaction-local `lock_timeout`. `RetryTurn` and retryable `SqlError` causes restart the activation; the uncommitted command is not stored, and the handle retries it with the same command id. An uncertain commit never resolves to a terminal success or failure: the retry resolves through the receipt.
- **Deterministic defects.** No receipt is written and no user code runs. The runtime logs `Deterministic actor defect` with the cause, annotated with actor, id, tenant, command, and command id, inside the turn span. The caller observes `Die`; the activation stays resident.
- **Delivery timeout.** After command identity acquisition, `policy.deliveryTimeout` bounds admission, receipt reads, retries, and the caller's reply wait. A turn already running continues; once committed, its receipt remains resolvable by an authorized original caller within the retry horizon. Timing out before commit does not imply acceptance.
- **Internal commands.** A non-`System` caller reaching an `internal` command is a deterministic defect, not an `ActorError`.

Verification: gates **Crash points**, **Intent rollback**, **Turn boundary at runtime**, and **State migration chain** in conformance.
