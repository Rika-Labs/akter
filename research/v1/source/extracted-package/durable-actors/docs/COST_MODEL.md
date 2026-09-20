# Cost model and unit economics

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## No margin forecast without workload evidence

Earlier conversational revenue/margin numbers were hypotheses, not cost measurements. This package replaces them with a reproducible parameterized model under `models/`. Inputs are labelled assumptions; vendor rate pages are references to verify, not evidence for negotiated discounts. The model is not a prediction of customer demand, contract size or profitability.

## Cost drivers

One user command may create application writes, indexes, a command receipt, event records, projection rows, outbox entries and cleanup updates. Retries and relay delivery add more work. A 'million actor requests' is not comparable to a competitor's million HTTP requests or million physical SQL rows. Measure the real write amplification factor before setting a bundled command price.

Separate actor DB count/provisioning quotas from stored bytes; process/cluster baseline from per-request compute; active memory duration from external wait time; and outbound bytes from provider 'egress-free' claims. Retained events, blobs, backups, customer projection outages and orphan resources all cost money.

## Model structure

Revenue = platform fee + billed command/IO usage + active compute + retained DB/blob storage + outbound transfer + explicit enterprise services.

COGS = actor DB subscription/volume contract + billable database reads/writes/storage + runner/gateway/relay compute + PostgreSQL baseline/usage + object storage requests/storage/transfer + telemetry + payment processing + support allocation + abuse/free-tier reserve.

Gross margin = (revenue - COGS) / revenue. Payroll for product engineering, sales and general overhead is operating expense; production support may be allocated to COGS. State the policy rather than calling all subscription revenue profit.

## Scenarios

Model a small mostly-idle application, normal control-plane workload, write-heavy workload and high-fanout realtime workload. Scale workload volume separately from customer count. Compare retail backend assumptions with hypothetical negotiated rates, without assuming discounts arrive at a particular volume.

The supplied script computes exact arithmetic and emits CSV/JSON. It deliberately exposes negative-margin configurations when bundled pricing does not cover amplified writes. Use measured counters to replace assumptions; do not tune the model until it produces an attractive margin.

## What to obtain before pricing

A provider quote for DB counts/provisioning/read/write/storage; a production-region compute benchmark; per-command write histogram; egress paths; observed support load; restore/retention costs; and an allocation method for platform fixed costs. Run reconciliation between provider bills and internal meters.

## Sources and evidence

- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [P02: PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing) — Instance, storage, replica and pooling costs need region/configuration-specific pricing.
- [D04: Railway resource pricing](https://railway.com/pricing) — Meter and plan source; model unverified rates as assumptions.
- [A02: Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) — S3-compatible storage alternative, request/storage billing; ecosystem egress still exists.
- [C05: Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) — Requests, duration and storage meters; not directly comparable to our internal messages.
- [C03: Rivet Cloud](https://rivet.dev/cloud/) — Managed cloud and pricing reference; historical prices not assumed current.
