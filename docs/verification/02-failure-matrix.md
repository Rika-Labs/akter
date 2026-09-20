# Failure matrix

**Responsibility:** make crash behavior testable.  
**Authority:** evidence.  
**Owner role:** verification/reliability.

For every durable operation, test failure before admission, during execution, before commit, after commit, before acknowledgment, during delivery, after provider success, and during recovery.

Each row must state expected durable state, externally visible response, retry identity, operator signal, and safe remediation. A test that only asserts “no exception” is insufficient.
