# Effect Cluster — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Virtual entity routing, persistent-message machinery, ownership coordination and passivation.

## Alternatives
Rivet/DO hosting; Orleans/Dapr; custom cluster. Reuse Cluster for the Effect-native self-host product.

## Selection rationale
Avoid rebuilding hard distribution primitives while adding a narrow durability kernel.

## Maturity
Pin source and verify current semantics; old bug reports are not current defect proof.

## Performance
Measure hot keys, cold activation, mailbox scans, DB contention and routing separately.

## Developer experience
Typed RPC/entity clients align with desired protocol/implementation split.

## Effect integration
Native substrate, not a hidden foreign runtime.

## Bun integration
Transport adapter must be tested under Bun with real DB failures.

## Node compatibility
Existing Node platform examples provide a reference path, still requiring our conformance.

## CI behavior
Use TestRunner for units; real PostgreSQL/two-runner integration for correctness.

## Local behavior
In-process mode helps quick iteration but does not prove leases/remote storage.

## Production behavior
Unique runner addresses and session-sensitive storage behavior are acceptance gates.

## Maintenance risk
Private API dependence would magnify RC churn; use public contracts where possible.

## Licensing
Covered by Effect licensing, with provider licenses separate.

## Pricing
Costs come from control DB traffic, runner memory, fan-out and retained metadata.

## Lock-in
Public Actor API hides transport specifics; semantics remain intentionally tied to tested Cluster behavior.

## Migration path
Replace only after concrete limitations; preserve wire/receipt contracts.

## Known issues / uncertainties
Volatile default messages, sink fencing and cross-store atomicity gaps need explicit treatment.

## Operational burden
Shard ownership, drain, recovery, backlog and version routing need operator tooling.

## Security implications
Internal messages still require trusted namespace/routing and tenant admission controls.

## Sources
- [Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts)
- [SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts)
- [Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts)
- [PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer)
- [Railway private networking](https://docs.railway.com/guides/private-networking)
