# Failure matrix

**Responsibility:** make crash behavior testable.  
**Authority:** evidence.  
**Owner role:** verification/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Every row MUST assert durable rows, caller result, retry identity, activation state, and later delivery—not merely absence of an exception.

| Fault point                            | Required result                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Before handler                         | No business consequences; same envelope may be redelivered.                                                    |
| During handler / before COMMIT         | Transaction rolls back receipt, state, events, intents, and effects; activation restarts for retryable defect. |
| Deterministic defect                   | Rollback; caller receives `Die`; `onDefect` gets read-only context; actor remains resident.                    |
| After COMMIT / before reply            | Retry with the same command id replays output or declared failure; handler does not run twice.                 |
| Intent turn rolls back                 | No receiver turn occurs.                                                                                       |
| Neki relay after source COMMIT         | Relay retry creates one `cluster_messages` record for the intent id.                                           |
| Runner dies in a paused turn           | Transaction rolls back; no takeover before lock expiry; survivor redelivers after expiry.                      |
| Stale generation                       | Database fence prevents commit.                                                                                |
| State decode or size defect            | No partial write; deterministic-defect behavior applies.                                                       |
| Workflow resumes elsewhere             | Owner, tenant, key, and caller attribution remain unchanged.                                                   |
| Event races workflow wait registration | The matching owner event resolves exactly one wait.                                                            |
| Parked connection wakes                | `conn.state` is restored, `resumed` is true, and activation-local `vars` restart fresh.                        |
| Singleton runner dies                  | Exactly one survivor resumes `run` and cron responsibility.                                                    |
| HTTP credentials absent/changed        | No credentials: no turn and Unauthorized; distinct tokens: distinct principals.                                |

Run applicable rows on PGlite, Postgres, Neki, the in-process multi-runner harness, and the served HTTP harness. Real Postgres is mandatory for lock-contention rows.
