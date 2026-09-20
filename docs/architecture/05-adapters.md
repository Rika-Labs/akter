# Backend and service adapters

**Responsibility:** separate portable contracts from provider mechanics.  
**Authority:** design.  
**Owner role:** platform/runtime.

Adapters exist for Postgres, the managed cloud backend, blob storage, transports, clocks, and external providers. An adapter may narrow support, but may not silently weaken a stated guarantee.

Every adapter documents transaction scope, isolation, locking, change feeds, prepared statements, pooling, retention, and failure behavior. A Postgres-compatible wire protocol is not evidence of Postgres-equivalent semantics.
