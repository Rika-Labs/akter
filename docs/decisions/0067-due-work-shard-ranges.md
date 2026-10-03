# ADR 0067: Due-work scans use the data shard map

**Status:** implementation decision (2026-10-03).

**Responsibility:** implement the per-data-shard claims required by ADR 0021, including connection-holder liveness, and audit framework uniqueness for shard-local enforcement (#484 and #486).

**Authority:** design decision record.

**Owner role:** runtime and database.

**Change policy:** supersede through a new ADR.

## Decision

The internal `ShardMap` supplies inclusive, non-overlapping bucket ranges independently of Effect Cluster's actor compute ownership. Its default is one range, `[-128, 127]`, on the existing database. There is no topology discovery or public configuration API in this change.

Each relay pass claims one range at a time, combining intents, uncapped jobs, feed, control, and subscription deliveries in the existing statement. Each next range receives only the runner's remaining free capacity, so claimed work never waits locally behind an exhausted lane. The first range rotates between passes to prevent a busy range from monopolizing a lane. Capped-job discovery uses the same ranges; each actor's existing advisory-lock transaction still enforces its cap. Receiver receipts, leases, failed-settle recovery, and cron rewrites are unchanged.

The holder performs one liveness read per range and combines all results before ending a missing connection. A failure of any read remains a failed liveness check, not evidence that connections in unread ranges disappeared.

A range may carry a Neki shard UID. Such a range receives a dedicated, scoped Postgres session configured with `SET __neki.shard` before its first scan. This session is never borrowed from the shared off-turn pool, so its target cannot escape into ordinary keyed queries or DDL. The ordinary single-database range reuses its existing client without connection reservation, settings, or transaction control. Its claim still costs one SQL statement and one network flight.

## Schema audit

All 18 current per-actor and per-tenant framework tables already include `routing_key` in their primary keys. The outbox's partial unique timer index also includes it: 19 unique indexes in total. No repair migration is necessary, and no existing data or key is rewritten. The foundation's pre-routing keys are replaced by the existing `0003_routing_state` migration, not left in the final schema.

The other framework tables are deployment registries or deployment-wide observations: `actor_adoption_writes`, `actor_adoptions`, `actor_content_types`, `actor_deployment`, `actor_fleet_views`, `actor_migrations`, `actor_payload_versions`, `actor_payload_writers`, `actor_placements`, `actor_routed_subscriptions`, `actor_tables`, and `actor_workflow_manifests`. These are not per-actor uniqueness claims and must remain in one shard group. Cluster-owned tables likewise stay in their single shard group. Giving a registry a synthetic routing key would not fix a per-actor duplicate and would change its existing consumers and conflict targets.

## Evidence and limits

- `runtime/database/migrations.test.ts` enumerates the migrated Postgres catalog's unique indexes, including constraint-backed and standalone partial indexes. It checks every non-registry framework key for `routing_key`, and injects an unkeyed unique index to demonstrate detection.
- `runtime/database/shards.test.ts` exercises asymmetric owned boundaries, out-of-range work, a real row lock with `SKIP LOCKED`, failed settles, both public-API work ranges, holder liveness, and session-target isolation. It counts the default claim's executions with the statement recorder and its network flights through a measured transport, without requiring a preloaded Postgres extension. The minutely workload starts one second past a minute boundary so its one-minute advance spans exactly one tick; redelivery of each original tick id leaves one receipt and one committed cron transition on each range.
- The session-setting test uses Postgres custom settings and proves only session isolation and setting text, not Neki routing. `EXPLAIN (NEKI_PLAN)` and exactly-once effects across a real two-shard Neki topology remain unverified, pending #66 and a supplied topology map. This amends ADR 0057's finding that no shard map or per-range scan exists; it does not mark the Neki gate passed.
