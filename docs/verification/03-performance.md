# Performance and capacity

**Responsibility:** replace scaling assumptions with measurements.  
**Authority:** evidence.  
**Owner role:** performance/reliability.

Measure command p50/p95/p99, hot-actor throughput, database round trips, pool waits, WAL/storage growth, mailbox age, worker recovery, live-query maintenance, gateway memory, reconnect waves, and blob orphan volume.

Record runtime/backend versions, indexes, dataset size, key skew, hardware, durability settings, concurrency, and failure conditions. Never turn an estimate into a product promise without a reproducible benchmark.
