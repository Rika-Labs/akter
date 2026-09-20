# ADR 030: Measure amplification before public rates

Date: 2026-09-17  
Status: Required commercial gate

## Context
Retail per-row/storage charges and platform costs can exceed a simple cheap per-command price after receipts/outboxes/indexes/retries.

## Decision
Use an explicit cost model and provider quotes; offer bounded design-partner commitments before a public usage rate card.

## Alternatives considered
Assuming 70-80 percent margins, huge enterprise contracts or automatic volume discounts is rejected as unsupported.

## Consequences and risks
Usage metering must reconcile with invoices and separate customer work from platform retry overhead.

## Validation and revisit trigger
G12; revisit every rate when backend or workload amplification changes.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Turso pricing](https://turso.tech/pricing.md)
- [PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing)
- [Railway resource pricing](https://railway.com/pricing)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
