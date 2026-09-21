# Failure matrix

**Responsibility:** make crash behavior testable.  
**Authority:** evidence.  
**Owner role:** verification/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Every row MUST assert durable rows, caller result, retry identity, activation state, and later delivery—not merely absence of an exception.

| Fault point                                                        | Required result                                                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before handler                                                     | No business consequences; same envelope may be redelivered.                                                                                                      |
| During handler / before COMMIT                                     | Transaction rolls back receipt, state, events, intents, and effects; activation restarts for retryable defect.                                                   |
| Deterministic defect                                               | Rollback; caller receives `Die`; `onDefect` gets read-only context; actor remains resident.                                                                      |
| After COMMIT / before reply                                        | Retry with the same command id replays output or declared failure; handler does not run twice.                                                                   |
| Intent turn rolls back                                             | No receiver turn occurs.                                                                                                                                         |
| Neki relay after source COMMIT                                     | Relay retry creates one `cluster_messages` record for the intent id.                                                                                             |
| Neki relay after destination insert / before source acknowledgment | Retry preserves the same intent identity; no second logical destination message or retained receiver transition.                                                 |
| Caller delivery timeout / disconnect                               | The admitted turn may still commit; retrying the same command id observes its receipt instead of cancelling or duplicating it.                                   |
| Declared failure after attempted writes                            | Persist and replay the terminal typed failure unchanged; explicitly verify the chosen business-write semantics without accidentally redelivering it as a defect. |
| Provider success / result acknowledgment lost                      | Preserve the ambiguous outcome; reconcile or retry under provider idempotency rather than assuming the call failed.                                              |
| Runner dies in a paused turn                                       | Transaction rolls back; no takeover before lock expiry; survivor redelivers after expiry.                                                                        |
| Stale generation                                                   | Database fence prevents commit.                                                                                                                                  |
| State decode or size defect                                        | No partial write; deterministic-defect behavior applies.                                                                                                         |
| Workflow resumes elsewhere                                         | Owner, tenant, key, and caller attribution remain unchanged.                                                                                                     |
| Event races workflow wait registration                             | The matching owner event resolves exactly one wait.                                                                                                              |
| Parked connection wakes                                            | `conn.state` is restored, `resumed` is true, and activation-local `vars` restart fresh.                                                                          |
| Socket-owning process dies                                         | Client reconnects; durable events replay from an exclusive cursor or report retention loss. Activation parking alone does not preserve this socket.              |
| Singleton runner dies                                              | Exactly one survivor resumes `run` and cron responsibility.                                                                                                      |
| HTTP credentials absent/changed                                    | No credentials: no turn and Unauthorized; distinct tokens: distinct principals.                                                                                  |

Run applicable rows on PGlite, Postgres, Neki, the in-process multi-runner harness, and the served HTTP harness. Real Postgres is mandatory for lock-contention rows.

These are required tests, not recorded passing results. Each implementation must attach evidence and an operator signal/remediation path for the failures it claims to recover from.
