# Durability and recovery contract

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Terms

**Accepted**: a command exists in the chosen durable delivery store. **Committed**: its actor-local outcome and mutation have committed together. **Delivered**: an outgoing intention has reached its durable destination. **Observed**: a client has consumed an event/result. These are different events.

The target is at-least-once transport with deduplicated local transitions—not exactly-once execution of arbitrary code. Receipts and replay windows are bounded policies; identifiers cannot be freely recycled after their deduplication history is discarded.

## Authority and fencing

A placement lease identifies a candidate owner. It is not sufficient to protect a remote database. Every activation receives a monotonically ordered fencing token. Before serving, it installs that token in the actor database. Ownership becomes effective at that storage-side handoff. Every mutation transaction checks the token on the same connection and under the write lock that protects subsequent mutations.

A prior owner that resumes after a pause must fail its conditional fence check. A prior transaction already holding the write lock can complete before the successor installs its fence; the successor waits and takes authority only when the handoff commits. Do not claim the earlier PostgreSQL lease timestamp is the linearization point for a remote SQLite write.

Tokens are issued only by the trusted runtime. An old runner cannot mint a newer epoch. Tokens from different database incarnations cannot be reused. Database restore/clone requires a new incarnation and coordinated replay policy.

Fencing prevents stale state commits. It does not undo an external payment already accepted by a provider. External work requires its own idempotency/reconciliation policy.

## The local commit

A command is processed in one actor-local database transaction:

1. Validate current database incarnation and activation fence.
2. Look up `(application, actor incarnation, command ID)` receipt and compare payload digest.
3. Execute application mutations through the turn-bound Database client.
4. Append declared domain events and projection change records.
5. Stage outgoing messages, timer intents, activity requests and artifact references.
6. Store encoded result/error and commit metadata in the receipt.
7. Commit.

The same idempotency key with a different payload returns a conflict. Expected domain failures need a documented policy: roll back application changes to a savepoint, then commit a rejected-command receipt, or reject without retention. The chosen default is a retained domain rejection with no partial application mutation. Defects and infrastructure failures roll back and follow bounded retry/dead-letter policy.

## Bridging to PostgreSQL

No `Layer` or Effect SQL wrapper makes Turso plus PostgreSQL atomic. A relay publishes committed local intents using stable destination IDs. A durable PostgreSQL relay task/receipt is registered before the inbound message is retired. On a crash after local commit, Cluster redelivers and the local receipt yields the original outcome. On a crash after destination acceptance but before local cleanup, the relay resends the same IDs and destination deduplication absorbs it.

A success response means the actor-local commit is durable and any required runtime delivery tracking is durably registered. It does not mean every downstream projection, email, or timer action has completed.

## Failure matrix

| Failure point | Expected recovery | Forbidden behavior |
|---|---|---|
| Before acceptance | Caller retries stable idempotency key | Claim accepted work exists |
| Accepted, before local tx | Redeliver | Lose acknowledged command |
| Mid local tx | Rollback, retry | Persist partial state |
| Local commit, before Postgres reply | Read receipt, restore reply, resume relay | Repeat mutation |
| Remote destination accepted, before relay checkpoint | Resend stable delivery ID | Generate fresh ID each retry |
| Old owner resumes | Fence check fails | Write from stale activation |
| External provider succeeded, outcome unknown | Reconcile or request intervention | Blindly repeat unsafe effect |
| Sink offline | Retain bounded backlog, surface lag | Drop projected changes silently |
| Process gone with live subscribers | Reconnect and replay journal | Treat a PubSub queue as retained history |

## Required proof

Use crash failpoints at every transition, including after a commit response is lost. Run against actual remote libSQL and PostgreSQL, not only mocks. Validate the DB driver's rollback/commit/interrupt behavior, query parameterization, busy retries, transaction limits and primary-read semantics. Use an independently computed invariant oracle: balances or counters, distinct command receipts and outgoing intent IDs. A test suite passing in-memory is not evidence for remote driver semantics.

## Durability exclusions

Arbitrary external I/O inside a transaction, direct writes to reserved runtime tables, out-of-band actor DB writers, raw untracked command submission, and modifying an old migration violate the standard contract. Developer code is trusted within its deployment; mutually untrusted tenants require process/container and credential isolation beyond Effect services.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [Q02: SQLite transaction model](https://www.sqlite.org/lang_transaction.html) — Write transaction and locking semantics; supports analysis of local receipts/fence checks.
