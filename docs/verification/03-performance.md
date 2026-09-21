# Performance and capacity

**Responsibility:** replace scaling assumptions with measurements.  
**Authority:** evidence.  
**Owner role:** performance/reliability.
**Change policy:** a change requires the conformance suite to be updated in the same change.

Benchmarks MUST measure command p50/p95/p99, hot-actor throughput, transaction duration, database round trips and pool waits, receipt/event/outbox growth, mailbox age, hibernation and wake latency, parked-connection memory, event replay lag, workflow resume latency, Neki relay lag, and recovery after runner death.

Capacity tests MUST include `State.maxBytes`, the 16 KiB connection-state limit, cluster principal-header size, mailbox capacity, event retention, and reconnect waves. Singleton tests MUST show one active `run` and one cron tick across runner counts.

Every result MUST record runtime and backend versions, deployment mode, topology, database settings, indexes, dataset size, tenant/key skew, hardware, concurrency, durability settings, and injected failures. PGlite results MUST NOT be generalized to lock contention or multi-process Postgres/Neki behavior.

No estimate becomes a product claim without a reproducible command, fixture, raw result, and acceptance threshold.
