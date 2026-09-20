# Actor identity and authority

**Responsibility:** define what an actor is allowed to do.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** any authority change requires security review and adversarial tests.

An actor address is `(project, tenant, type, id)`. The runtime binds this identity from trusted routing and authentication context; application input cannot choose its owner.

An actor has one current writable generation at a time. A generation may read and mutate only through its phase-appropriate context. A lease, process-local object, or TypeScript type is not sufficient authority by itself; the database commit must be fenced.

The actor owns mutation of its declared aggregate. Authorized readers may observe relational state without becoming mutation authorities. Privileged migration and transfer paths are explicit, audited authorities and are not normal actor handlers.

Required outcomes:

- own-row mutation succeeds;
- foreign-row mutation fails explicitly without a partial write;
- missing or unauthorized rows do not become an existence oracle;
- stale generations cannot commit;
- transfer has one writable owner at every durable phase.

Unsupported SQL shapes must be rejected or routed through a reviewed privileged path. The framework must not claim that a mutable session setting or a TypeScript import is a security boundary.
