# Security and tenancy

**Responsibility:** define trust boundaries and tenant isolation.  
**Authority:** normative.  
**Owner role:** security/runtime.  
**Change policy:** security review is required for auth, SQL, transfer, blob, and admin changes.

The runtime distinguishes principal, tenant, project, actor, operator, and provider identity. Client-supplied addresses, tenant IDs, blob keys, and cursors are requests, not authority.

Authorization is checked independently for commands, reads, subscriptions, signals, blobs, transfers, administration, and repair. Logs redact credentials, signed URLs, tokens, and sensitive payloads.

Durable Actors is trusted application code, not a hostile-code sandbox. Customer code running in the process must not be described as isolated from the process owner or other trusted handlers.
