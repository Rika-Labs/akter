# Provider due-diligence questions

## Turso

- Which exact engine and wire protocol will our account use, and is @libsql/client supported under the proposed capacity agreement?
- Are triggers, JSON functions, interactive write transactions and transactional DDL supported with documented limits?
- What does a lost commit response mean, and how do we retrieve/confirm its outcome?
- What primary/session read guarantees can we request? What does failover do to open transactions?
- Can we conditionally install/check a fencing epoch in the same transaction as arbitrary app writes?
- What are limits and pricing for DB count, creation rate, tokens, storage, indexed writes, backup/PITR and exports?
- Can we export a fleet without a proprietary format? What are recovery and deletion semantics?

## PlanetScale

- Which endpoint preserves a reserved session for advisory locks? How are disconnects, failover and pooling handled?
- What connection/quota/latency envelope can the control workload sustain?
- Are all SQL features/locks used by the pinned SqlRunnerStorage supported? What changes with Neki?
- What backup/restore guarantees and operational visibility apply to the control store?

## Railway

- Can every runner advertise a uniquely reachable private endpoint through scale-out and replacement?
- What is the routing behavior of a service DNS name with multiple replicas?
- What are graceful shutdown limits, autosleep behavior, health/readiness controls and outbound network costs?
- Can we isolate customer deployments and attach least-privilege credentials without shared process access?

## Object/secrets/telemetry providers

- What S3 methods/signatures/conditional semantics do we rely on and which are unsupported?
- What traffic is billed on every hop, not merely provider outbound egress?
- Can secret grants and rotation be application/tenant-scoped and audited?
- What are telemetry cardinality, retention, sampling and privacy controls?

A vendor marketing page is not a contract. Record written answers and test evidence with the exact plan/region/version before commercial commitments.
