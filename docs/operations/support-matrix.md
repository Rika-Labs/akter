# Backend support matrix

**Responsibility:** show real capability differences by backend.  
**Authority:** operational evidence.  
**Owner role:** platform/verification.
**Change policy:** a change requires operator review when a procedure or limit changes.

Support means the shared `durable-actors/testing` conformance suite passes and the deployment-specific gates are demonstrated.

| Capability                       | PGlite                  | Postgres                     | Neki        | Evidence required                                 |
| -------------------------------- | ----------------------- | ---------------------------- | ----------- | ------------------------------------------------- |
| Real turn path and serialization | supported               | supported                    | gated       | conformance suite                                 |
| Generation `FOR UPDATE` fence    | single-process coverage | supported                    | gated       | lock and pinning tests                            |
| Multi-connection lock tests      | unsupported             | supported                    | gated       | `holdLock` cases                                  |
| Tenant-scoped transactions       | supported               | supported                    | gated       | isolation tests                                   |
| Direct intent write with turn    | supported               | supported                    | unsupported | Neki uses relay                                   |
| `actor_outbox` relay             | not applicable          | not required                 | gated       | crash-after-commit recovery and exactly-once move |
| Cross-runner wake notification   | test clock              | `LISTEN/NOTIFY` plus polling | gated       | delivery-latency test                             |
| Migrations and restore           | development only        | supported                    | gated       | migration and restore rehearsal                   |

Topology is a separate gate. Multi-replica Railway support requires a reachable per-replica `railnet0` advertise address; otherwise use `Topology.k8s` or service-per-runner. Singleton support requires a two-runner uniqueness and failover test.

An unverified cell remains gated. Postgres wire compatibility is not evidence of locking, pooling, transaction, or restore equivalence.
