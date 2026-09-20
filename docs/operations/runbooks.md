# Operator runbooks

**Responsibility:** provide repeatable recovery actions.  
**Authority:** operational.  
**Owner role:** operations/reliability.

Runbooks are required for stuck actors, stale generations, mailbox backlog, dead letters, unknown external effects, failed transfers, live-query lag, gateway reconnect storms, blob orphans, failed migrations, tenant isolation incidents, and restore.

Each runbook must state symptoms, queries, safe actions, forbidden actions, escalation evidence, and how to verify recovery. Never recommend deleting receipts, tombstones, or runtime rows as a first-line fix.
