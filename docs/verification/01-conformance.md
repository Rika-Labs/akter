# Conformance

**Responsibility:** ensure every backend and transport obeys the same contracts.  
**Authority:** evidence.  
**Owner role:** verification.

Run the invariant suite against real Postgres and every supported backend. Include own and foreign mutations, duplicate commands, rollback, commit-before-response, stale generations, lost notifications, reconnect, resync, worker restart, provider ambiguity, and restore.

Mocks and PGlite can accelerate unit tests but cannot establish multi-process locking, pooling, shard locality, or provider behavior.
