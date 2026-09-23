# Failure matrix

**Responsibility:** make crash behavior testable.  
**Authority:** evidence.  
**Owner role:** verification/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Every row MUST assert durable rows, caller result, retry identity, activation state, and later delivery—not merely absence of an exception.

Unless a row exercises denial or expiry, external receipt replay assumes the original logical caller remains authorized and the command identity is unexpired. Trusted internal recovery retains its accepted-work authority; see [receipts](../contracts/04-receipts.md).

| Fault point                                                           | Required result                                                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before handler                                                        | No business consequences; the caller's retry with the same command id executes once.                                                                                              |
| During handler / before COMMIT                                        | Transaction rolls back receipt, state, events, and outbox rows; activation restarts for retryable defect; the caller retries the same command id.                                 |
| Deterministic defect                                                  | Rollback; caller receives `Die`; the `X.onDefect` hook gets read-only access; actor remains resident.                                                                             |
| After COMMIT / before reply                                           | Retry with the same command id replays output or declared failure; handler does not run twice.                                                                                    |
| Intent turn rolls back                                                | No receiver turn occurs.                                                                                                                                                          |
| Relay crash after sender COMMIT                                       | The next relay pass delivers the same intent id; the receiver executes it once.                                                                                                   |
| Relay crash after receiver commit / before outbox row deletion        | Redelivery replays the receiver's receipt; no second receiver transition.                                                                                                         |
| Caller delivery timeout / disconnect                                  | The admitted turn may still commit; retrying the same command id observes its receipt instead of cancelling or duplicating it.                                                    |
| Declared failure after attempted writes                               | Roll back all business work and staged notifications; commit only the terminal typed failure outcome with the fence/receipt. Redelivery replays it without rerunning the handler. |
| Provider success / result acknowledgment lost                         | Preserve the ambiguous outcome; reconcile or retry under provider idempotency rather than assuming the call failed.                                                               |
| Runner dies in a paused turn                                          | Transaction rolls back; no takeover before lock expiry; the caller retries the same command id against the new owner.                                                             |
| Stale generation                                                      | Database fence prevents commit.                                                                                                                                                   |
| State decode or size defect                                           | No partial write; deterministic-defect behavior applies.                                                                                                                          |
| Workflow resumes elsewhere                                            | Owner, tenant, key, and caller attribution remain unchanged.                                                                                                                      |
| Event races workflow wait registration                                | The matching owner event resolves exactly one wait.                                                                                                                               |
| Parked connection wakes                                               | Connection `state` is restored, `resumed` is true, and activation-local values restart fresh.                                                                                     |
| Socket-owning process dies                                            | Client reconnects; durable events replay from an exclusive cursor or report retention loss. Activation parking alone does not preserve this socket.                               |
| Singleton runner dies                                                 | Exactly one survivor resumes the background loop and cron responsibility.                                                                                                         |
| HTTP credentials absent/changed                                       | No credentials: no turn and Unauthorized; distinct tokens: distinct principals.                                                                                                   |
| Adapter ownership override, missing scope, or escaped turn capability | Reject without foreign or independently committed writes; concurrent contexts never exchange ownership.                                                                           |
| Drain deadline expires                                                | Report forced/deadline-expired drain, interrupt local execution, preserve pending work and provider ambiguity, and permit takeover only after safe loss of old authority.         |
| Hosted assertion forged, expired, or bound to a different request     | Reject before admission; valid newly authenticated retries retain command identity. Expiration after admission does not cancel durable work.                                      |
| Application credential attempts operator repair                       | Reject without repair; authorized repair records the operator, resource scope, and reason and still respects provider-outcome safety.                                             |
| Different caller reuses a committed command id                        | Deny outcome access without a second execution; credential rotation for the original caller preserves access only while currently authorized.                                     |
| Access revoked before admission / after durable admission             | Reject new external work and result reads; previously accepted work recovers with recorded attribution unless explicitly canceled or subject to application reauthorization.      |
| Live or parked session loses authorization                            | Reauthorize or disconnect within the documented revocation bound; resumption, reconnect, and replay do not bypass it.                                                             |
| External identity expires before delivery or retry                    | Reject without new execution, including after receipt pruning; no automatic fresh-id retry and no assertion that earlier work failed.                                             |
| Cleanup races retry / crashes before completion                       | Preserve supported replay and pending internal deduplication; no missing-record gap permits a second execution.                                                                   |
| Restore, clock change, or version skew at the retry horizon           | Preserve enforceable external expiry and accepted internal recovery; do not refresh an old identity or bypass provider reconciliation.                                            |

| Pipelined batch N fails to commit | Batch N+1's staged work is discarded unseen; the activation restarts and every uncommitted caller retries. |
| Caller gives up before a reply | Retrying the same id reports the committed outcome or executes once; a new id is a new operation. |
| Commutative merge turn fails | No original command commits; each caller retries its own id and may merge again. |
| Optimistic reducer rejected by the server | The browser handle removes the pending input and shows committed state. |
Run applicable rows on PGlite, Postgres, Neki, the in-process multi-runner harness, and the served HTTP harness. Real Postgres is mandatory for lock-contention rows.

These are required tests, not recorded passing results. Each implementation must attach evidence and an operator signal/remediation path for the failures it claims to recover from.
