# Railway — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Initial application compute/deployment platform.

## Alternatives
Kubernetes, ECS, Fly, VMs. Railway chosen for pilot simplicity, not universal cluster semantics.

## Selection rationale
Managed app deployment reduces early ops work.

## Maturity
Validate actual private-network/replica behavior for actor routing.

## Performance
Region/CPU/RAM/proxy behavior must be benchmarked with remote DBs.

## Developer experience
Monorepo role-based services and preview workflow.

## Effect integration
Effect app entries are normal services; no core Railway dependency.

## Bun integration
Bun image is primary after lifecycle/health testing.

## Node compatibility
Node-compatible image uses same protocol.

## CI behavior
Deploy only verified images/commits with protected credentials.

## Local behavior
Local mode does not require Railway.

## Production behavior
Unique runner endpoint and drain readiness are gates; no arbitrary scale-to-zero claim.

## Maintenance risk
Platform networking/deploy semantics can constrain Cluster.

## Licensing
Managed service terms apply.

## Pricing
Meter active resource use, persistent baseline, network and idle services.

## Lock-in
Container/entrypoint contract reduces lock-in; provider-specific routing still matters.

## Migration path
Move images to another platform after reproducing network/discovery and shutdown behavior.

## Known issues / uncertainties
Load-balanced service hostname is not one runner identity; replica routing must be proven.

## Operational burden
Health/readiness, rollout, private network, quotas and cost controls.

## Security implications
Isolate customer code deployments and credentials; restrict deploy tokens.

## Sources
- [Railway monorepos](https://docs.railway.com/guides/monorepo)
- [Railway private networking](https://docs.railway.com/guides/private-networking)
- [Railway configuration](https://docs.railway.com/reference/config-as-code)
- [Railway resource pricing](https://railway.com/pricing)
