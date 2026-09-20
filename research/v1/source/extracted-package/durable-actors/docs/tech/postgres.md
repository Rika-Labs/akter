# PlanetScale PostgreSQL — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Managed Cluster/control storage, not a universal customer application projection schema.

## Alternatives
Other managed PostgreSQL; self-host PG; distributed SQL. Prefer compatibility before scale features.

## Selection rationale
User-selected provider with standard Postgres interface; acceptance gates remain.

## Maturity
Core PostgreSQL is established; provider features and Neki preview assessed separately.

## Performance
Measure direct/session locks, pending-message queries, regional latency and connection waits.

## Developer experience
Managed backups/operations can simplify pilots; roles and endpoint names must be clear.

## Effect integration
Use Effect SQL PG and Cluster storage via distinct named bindings.

## Bun integration
Test PG driver sockets/TLS/session loss on Bun.

## Node compatibility
Reference Node path also tested.

## CI behavior
Local PG for routine tests; provider integration protected and bounded.

## Local behavior
Docker PostgreSQL can emulate SQL basics, not managed failover/pool behavior.

## Production behavior
Runner locks use direct/session-affine endpoint; pooling policy per role.

## Maintenance risk
Provider topology/pricing and experimental sharding may alter assumptions.

## Licensing
PostgreSQL license and PlanetScale service contract are separate.

## Pricing
Minimum cluster/replica/storage costs persist even when actors sleep.

## Lock-in
Wire compatibility helps, but backup/branch/pool and sharding features create coupling.

## Migration path
Keep migrations/provider-neutral roles and tested backup/export path.

## Known issues / uncertainties
Transaction pooling does not retain session affinity; Neki is not assumed compatible with all Cluster queries.

## Operational burden
Schema maintenance, connection budgets, retention/vacuum, restore and failover drills.

## Security implications
Application actors never receive control DB credentials.

## Sources
- [PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer)
- [PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing)
- [Neki preview](https://planetscale.com/changelog/neki)
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html)
- [SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts)
