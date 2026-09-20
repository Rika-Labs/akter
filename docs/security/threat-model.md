# Threat model

**Responsibility:** identify security failure modes.  
**Authority:** security.  
**Owner role:** security/runtime.

Threats include forged addresses, cross-tenant reads, foreign-row mutation, replayed commands, stolen receipts, leaked signed URLs, stale writers, malicious SQL, compromised workers, operator misuse, restore rollback, and provider identity confusion.

Assume clients are hostile and application input is untrusted. Do not assume application handlers are hostile-code isolated from the runtime; Durable Actors is a trusted application framework, not a sandbox.

Every threat needs a control, a test, a logging signal, and a recovery path.
