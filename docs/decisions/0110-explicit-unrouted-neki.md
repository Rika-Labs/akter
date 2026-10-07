# ADR 0110: Explicitly unrouted Neki databases

**Status:** accepted (2026-10-07).

**Responsibility:** declare Neki semantics without routing metadata for a database whose platform guarantees that no table is routed.

**Authority:** implementation decision. Amends [ADR 0094](0094-neki-shard-targeted-sessions.md) and [contract 06](../contracts/06-storage-ownership.md).

**Owner role:** runtime and platform provisioning. **Change policy:** supersede through a new ADR.

## Evidence and problem

ADR 0094 established readable topology for a service role, not an isolated customer login. On 2026-10-07, two disposable customer databases were provisioned through the hosted provisioner on a preview Neki cell. The runtime login had `__neki` schema USAGE but neither topology function's EXECUTE privilege. Both the cell owner and preview admin were refused schema USAGE and EXECUTE grants on `__neki.get_data_topology()` and `__neki.get_data_topology_revision()`: SQLSTATE `42501`, `DDL on schema __neki is not allowed through the router`. A DDL propagation wait changed nothing. Both databases and logins were dropped and their absence checked in the catalogs.

The admin's topology was a cluster document containing shard groups, shard UIDs and a `databases` map. It named only `postgres`, not either customer database. Neither customer could read it, so customer-specific filtering and the safety of broader role membership are unknown. We do not grant a broader metadata role as a workaround.

The cluster default was authoritative and unrouted. The real `shardMapOf` returned the single untargeted range `[-128, 127]` for a disposable database. Reading topology cannot improve routing for a database that the platform keeps unrouted, but the unconditional read prevents that database from starting.

## Decision

`Database.postgres({ neki: { routing: "none" }, ... })` explicitly asserts that this database routes **no table**, for its entire lifetime. It is not an automatic response to unavailable topology. The platform owning the topology must keep every database/schema/table binding unrouted and drain these runtimes before changing that guarantee.

This mode never discovers, reads or refreshes topology functions. It creates no live directory, retains the single untargeted bucket range, and `routedTables` returns `[]`, so migrations retain joined inspection views. It remains Neki: turn sessions set `__neki.tx_mode = 'single'` and `__neki.fanout = 'single'` before `BEGIN`, cross-actor turn groups stay disabled, commit-version semantics stay Neki's, replicas stay refused, and startup/application DDL keeps autocommit and propagation barriers.

`neki: true` remains live-topology mode. An authorization failure during startup discovery or the initial topology/revision read is the typed, public `NekiTopologyAccessDenied` failure. Its message names required schema USAGE and function EXECUTE privileges and the explicit mode with its platform precondition. It never changes modes. Other startup topology errors still stop startup. A server without Neki topology functions retains the existing Postgres stand-in behavior; absence is not permission denial.

## Failure boundary and limitations

[ADR 0093](0093-neki-routing-topology.md) observed 117 untargeted framework statement shapes refused on a routed group, including admission's locking read, event/receipt writes, relay and retention. Joined inspection views were also refused. [ADR 0094](0094-neki-shard-targeted-sessions.md) established that shard-targeted sessions forward those statements. The explicit mode opens no targeted sessions, so those observed layouts fail loudly at migration or framework statements instead of being silently treated as supported static shard maps. Single-shard transaction mode also continues to refuse transactions reaching a second shard.

These observations are **not** proof that every possible subset of routed tables, changed query shape or provider version is rejected before any work commits. This mode cannot observe a topology change or enforce the platform assertion through the restricted login. It supports only an unrouted database; routing one behind its back violates the contract. It must not replace the live directory for a routed database, even one on a single physical shard. Broader provider guarantees and multi-shard safety are not inferred from PostgreSQL stand-ins.

## Verification

[Unrouted Neki verification](../verification/neki-unrouted.md) records provider results, the real-Postgres privilege boundary and wrong implementations each regression rejects. Issue [#687](https://github.com/Rika-Labs/akter/issues/687) tracks the public change. No merged migration is edited.
