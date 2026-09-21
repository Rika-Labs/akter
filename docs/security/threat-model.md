# Threat model

**Responsibility:** identify security failure modes.  
**Authority:** security.  
**Owner role:** security/runtime.
**Change policy:** a change requires security review.

Assume clients are hostile, input is untrusted, networks fail, runners restart, and operators can make mistakes. Application handlers are trusted code with database access; the framework is not a hostile-code sandbox.

| Threat                                      | Primary controls                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Forged or confused caller                   | per-call bearer auth, edge API-key-to-`Principal` mapping, signed caller envelope, `CurrentCaller` isolation |
| Cross-tenant read or mutation               | mandatory `tenant_id` predicates, actor ownership keys, optional RLS, isolation tests                        |
| Stale or duplicate writer                   | generation row locked `FOR UPDATE`, one commit, stale-generation rollback                                    |
| Replayed or conflicting command             | caller-minted stable command id, durable receipt, `CommandConflict` on changed input                         |
| Consequence from a rolled-back turn         | events, intents, effects, state, and receipt share the commit                                                |
| Lost or duplicated hosted intent            | tenant-shard `actor_outbox`, exactly-once relay receipt, next-pass crash recovery                            |
| Singleton split ownership                   | Cluster singleton registration plus two-runner uniqueness and failover gate                                  |
| Credential or payload disclosure            | redacted configuration, field classification, bounded telemetry, encrypted backups                           |
| Unauthorized repair                         | separate operator capability, audited dead-letter and migration commands                                     |
| Restore rollback repeats an external effect | provider idempotency keys, effect records, reconciliation before execution resumes                           |
| Activation memory treated as authority      | durable database facts only; memory, leases, and placement never authorize                                   |

`ActorError` exposes bounded reasons—`ActorUnavailable`, `MailboxFull`, `Timeout`, `CommandConflict`, `NotCreated`, `Unauthorized`, `InvalidInput`, and `TransportError`—without leaking secret internals. `isRetryable` and `retryAfter` guide clients without granting authority.

Every control needs a conformance or integration test, an observable failure signal, and a recovery procedure. Hosted claims additionally require the Neki relay and Railway topology verification gates.
