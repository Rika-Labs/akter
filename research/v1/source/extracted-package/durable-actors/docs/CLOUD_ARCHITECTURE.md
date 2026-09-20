# Managed cloud architecture

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Control plane versus data plane

Control plane owns organizations, deployments, code versions, region placement, actor catalogs, secret bindings, quotas, billing and operational actions. Data plane runs commands, persists local receipts/state, relays durable intentions, serves events and executes trusted configured workflows. Customer code should not gain control-plane credentials.

## Initial deployment

Use dedicated customer-application deployments for pilots. Reuse managed Turso and PlanetScale rather than building a storage engine. The cloud still owns the integration: retry/reconciliation, database provisioning, fence handoff, schema compatibility, observability and tenant limits. Managed storage does not outsource the correctness of the combined actor system.

## What we host

Runner/gateway/relay infrastructure; control metadata; per-actor databases through a vendor; standard BlobStore namespace; secret bindings and telemetry; deployment/recovery tools. We may operate the underlying services or procure them. Customer projection databases remain customer-owned; we deliver to them under an explicit connection and data-export contract.

## Isolation

Do not put all customers' arbitrary SQL tables into one shared application schema. Control metadata can be multi-tenant because we own that schema. Private actor data has per-actor/application credentials. Application code requires process/container isolation, resource controls and network egress policy. A separate actor ID or Effect Scope is not sufficient.

## Scaling boundaries

Scale gateways by connections, runners by active actors/turns, relay by backlog, and activity workers by external work. Cold identity count, active actor count, provision rate and hot-key load are separate capacity axes. Automatic scale-to-zero of all runners conflicts with the need to poll/wake durable work unless another always-available wake mechanism exists. Plan a minimum runtime/control baseline.

## Hybrid later

Private customer runners require authenticated registration, workload attestation, version compatibility, network routing, data locality and responsibility boundaries. A control plane outside a customer's VPC may still see metadata; document it. Do not market zero-data-egress simply because compute runs privately.

## Revenue boundary

Sell managed reliability and reduced operational work, not an unexplained premium over Cloudflare requests. Offer explicit commitments and support only after SLO data exists. Enterprise prices depend on isolation, reserved capacity and service obligations, not the size of a customer's brand name.

## Sources and evidence

- [C03: Rivet Cloud](https://rivet.dev/cloud/) — Managed cloud and pricing reference; historical prices not assumed current.
- [C05: Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) — Requests, duration and storage meters; not directly comparable to our internal messages.
- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [P02: PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing) — Instance, storage, replica and pooling costs need region/configuration-specific pricing.
- [D04: Railway resource pricing](https://railway.com/pricing) — Meter and plan source; model unverified rates as assumptions.
