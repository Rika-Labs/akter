# Authorization model

**Responsibility:** define authorization surfaces.  
**Authority:** security contract.  
**Owner role:** security/API.

Authorize commands, reads, mutations, subscriptions, replay, signals, presence, blob upload, blob download, transfers, administration, migration, repair, and reconciliation separately.

Principal, tenant, project, actor, operator, and provider identities are distinct. Client-provided tenant IDs, actor IDs, blob keys, and cursors are requested scopes, not proof of permission.
