# Threat model

Assume hostile clients, untrusted input, network loss, runner crashes, and operator mistakes. Handlers are trusted application code, not a hostile-code sandbox.

| Threat                              | Control and evidence boundary                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Forged caller or session            | Authentication before RPC, origin checks, bound sessions, reauthorization, authenticated peer forwarding          |
| Cross-store access                  | One store credential scope; isolated preview/production buckets and identities; provider-specific denial evidence |
| Stale writer                        | Create-once open epoch and segment chain, never a membership lease alone                                          |
| Replay or changed input under an id | Stable command identity, durable outcome, input conflict rejection and ten-minute client expiry                   |
| Speculative publication             | All replies and action consequences wait for segment durability; discard dependents on failure                    |
| Missing/corrupt state               | Hash-checked pages and intact checkpoint/tail recovery; refuse instead of defaults                                |
| Duplicate external I/O              | Journaled completed steps plus provider idempotency and reconciliation of ambiguous attempts                      |
| Unauthorized inspection or mutation | Separate scoped operator grants, audit-before-answer, audit-with-mutation                                         |
| Credential/payload disclosure       | Redaction and bounded telemetry, encrypted and restricted backup/export paths                                     |
| GC or fork race                     | Retained roots, fenced collector, grace period and isolated fork identities; E6 failure evidence required         |

The current served runtime allows only tenant `default`. General tenant isolation, slow-consumer behavior, provider atomicity, and hosted orchestration need their own accepted boundary and evidence. Local MinIO results do not certify a hosted provider. See [security contract](../contracts/10-security.md) and the [support matrix](../operations/support-matrix.md).
