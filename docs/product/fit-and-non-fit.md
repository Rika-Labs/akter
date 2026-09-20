# Product fit and non-fit

**Responsibility:** prevent inappropriate adoption and architecture drift.  
**Authority:** product boundary.  
**Owner role:** product/architecture.

Strong fits include per-user, per-tenant, per-room, per-document, device, agent, order, and workflow state with durable behavior and realtime needs.

Poor fits include one globally hot counter, globally atomic multi-actor analytics, hostile user code, arbitrary cross-entity transactions as the dominant operation, or systems with no durable relational source of truth.

The framework should explain these boundaries instead of weakening guarantees silently.
