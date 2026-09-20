# Backup and restore

**Responsibility:** restore service without duplicating authority or external effects.  
**Authority:** operational.  
**Owner role:** operations/reliability.

Restore is not merely replaying rows. Quiesce command and effect delivery, restore compatible runtime and business data, reconcile provider outcomes, re-establish ownership generations, validate retention dependencies, and only then reopen execution.

Document RPO, RTO, backup scope, encryption, tenant recovery, blob references, tombstones, and the operator evidence required before unquiescing.
