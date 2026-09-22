# Failure matrix

**Responsibility:** make crash behavior testable.  
**Authority:** evidence.  
**Owner role:** verification/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Every row MUST assert durable rows, caller result, retry identity, activation state, and later delivery—not merely absence of an exception.

Unless a row exercises denial or expiry, external receipt replay assumes the original logical caller remains authorized and the command identity is unexpired. Trusted internal recovery retains its accepted-work authority; see [receipts](../contracts/04-receipts.md).

| Fault point                                                           | Required result                                                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before handler                                                        | No business consequences; same envelope may be redelivered.                                                                                                                       |
| During handler / before COMMIT                                        | Transaction rolls back receipt, state, events, intents, and effects; activation restarts for retryable defect.                                                                    |
| Deterministic defect                                                  | Rollback; caller receives `Die`; `onDefect` gets read-only context; actor remains resident.                                                                                       |
| After COMMIT / before reply                                           | Retry with the same command id replays output or declared failure; handler does not run twice.                                                                                    |
| Intent turn rolls back                                                | No receiver turn occurs.                                                                                                                                                          |
| Neki relay after source COMMIT                                        | Relay retry creates one `cluster_messages` record for the intent id.                                                                                                              |
| Neki relay after destination insert / before source acknowledgment    | Retry preserves the same intent identity; no second logical destination message or retained receiver transition.                                                                  |
| Caller delivery timeout / disconnect                                  | The admitted turn may still commit; retrying the same command id observes its receipt instead of cancelling or duplicating it.                                                    |
| Declared failure after attempted writes                               | Roll back all business work and staged notifications; commit only the terminal typed failure outcome with the fence/receipt. Redelivery replays it without rerunning the handler. |
| Provider success / result acknowledgment lost                         | Preserve the ambiguous outcome; reconcile or retry under provider idempotency rather than assuming the call failed.                                                               |
| Runner dies in a paused turn                                          | Transaction rolls back; no takeover before lock expiry; survivor redelivers after expiry.                                                                                         |
| Stale generation                                                      | Database fence prevents commit.                                                                                                                                                   |
| State decode or size defect                                           | No partial write; deterministic-defect behavior applies.                                                                                                                          |
| Workflow resumes elsewhere                                            | Owner, tenant, key, and caller attribution remain unchanged.                                                                                                                      |
| Event races workflow wait registration                                | The matching owner event resolves exactly one wait.                                                                                                                               |
| Parked connection wakes                                               | `conn.state` is restored, `resumed` is true, and activation-local `vars` restart fresh.                                                                                           |
| Socket-owning process dies                                            | Client reconnects; durable events replay from an exclusive cursor or report retention loss. Activation parking alone does not preserve this socket.                               |
| Singleton runner dies                                                 | Exactly one survivor resumes `run` and cron responsibility.                                                                                                                       |
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

Run applicable rows on PGlite, Postgres, Neki, the in-process multi-runner harness, and the served HTTP harness. Real Postgres is mandatory for lock-contention rows.

These are required tests, not recorded passing results. Each implementation must attach evidence and an operator signal/remediation path for the failures it claims to recover from.
