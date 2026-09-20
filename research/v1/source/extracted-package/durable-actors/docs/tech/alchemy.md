# Alchemy — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Code-reviewed external infrastructure definitions/state.

## Alternatives
Terraform/Pulumi/manual provider APIs. Alchemy is preferred after exact API/provider validation.

## Selection rationale
Aligns with TypeScript workflow without requiring a new language.

## Maturity
Edition/version/provider availability must be verified; do not assume all APIs are Effect-native.

## Performance
Provisioning/refresh latency is an ops concern, not actor hot-path performance.

## Developer experience
One resource owner and explicit state/environment plan.

## Effect integration
Use genuine supported Effect integration where available, not fabricated Stack syntax.

## Bun integration
Run supported version under Bun in disposable infra tests.

## Node compatibility
Keep tooling/runtime requirements documented independently from framework compatibility.

## CI behavior
Preview only for trusted changes; apply protected/manual.

## Local behavior
No provisioning on install/dev; skeleton intentionally non-operational.

## Production behavior
Own selected external resources; Railway deployment ownership remains explicit.

## Maintenance risk
Provider APIs and IaC state migrations can be disruptive.

## Licensing
Verify selected package/license and cloud provider terms.

## Pricing
Provider resources cost money regardless of IaC library.

## Lock-in
State format/provider resource abstractions are coupling.

## Migration path
Export/import resource IDs and document manual recovery/drift ownership.

## Known issues / uncertainties
Do not conflate old Promise API with a newer Effect API or assume Railway provider support.

## Operational burden
State backups, secret protection, drift and teardown.

## Security implications
IaC state may contain sensitive IDs/values; least privilege and encrypted state.

## Sources
- [Alchemy](https://alchemy.run/)
- [Railway configuration](https://docs.railway.com/reference/config-as-code)
