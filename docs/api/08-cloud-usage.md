# Cloud usage and pricing contract

The public HTTP contract is available through `@rikalabs/akter-cli/cloud-api`. `CloudApi.billing.listPlans` returns the plan catalog and `CloudApi.usage.get` returns organization usage. Treat the schemas at the pinned package version as the decoder authority; they do not approve or deploy a pricing policy.

## 0.2 transition

The current source contract still includes compute-unit fields such as `computeSizes`, `runnerHours`, and compute pricing. Hosted 0.2 moves runtime data into Akter-managed environment stores. E8 owns the corresponding metering, prices, quota schema changes, and hosted evidence. Do not infer a compute-only bill, free storage, action allowance, or customer-database requirement from older fields.

Catalog machine weights describe compute unit-hours, not raw machine hours. Usage windows and cap units come from the active hosted response. Preserve typed refusals such as `QuotaExceeded` and their retry guidance rather than treating a failed usage read as zero.

No unapproved prices, included quantities, or caps are stated here. See [pricing and limits](../cloud/pricing-and-limits.md) for the framework/hosted distinction.
