# Migrations

**Responsibility:** change runtime and application schemas safely.  
**Authority:** operational.  
**Owner role:** operations/database.

Migrations use expand, deploy, backfill, validate, and contract phases when compatibility requires it. Runtime tables, protocol payloads, workflow journals, event retention, ownership metadata, and live-query plans are all migration surfaces.

No migration may assume every actor is awake, every worker is current, or every shard shares one snapshot.
