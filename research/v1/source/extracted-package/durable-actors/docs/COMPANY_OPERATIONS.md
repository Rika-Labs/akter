# Company operating plan

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## First responsibilities

A founding engineer owns durability/storage integration and failure evidence. Another engineer, when capacity permits, owns developer API/tooling/examples and platform deployment. One named owner handles security, provider credentials, incidents and restore procedures; this responsibility exists even before a formal operations hire.

Do not assume a fixed headcount or timeline. First estimate the gated spikes, then staff based on where evidence shows complexity. A fully managed multi-tenant code platform and a self-hostable framework require different skills; postponing broad cloud hosting reduces initial risk.

## Vendor conversations

Turso: exact engine/driver contract, database count/provisioning rates, storage/write economics, exports and support. PlanetScale: session/direct connection semantics, region latency, connection limits, failover and backup. Railway: unique runner addressability, drain timeouts, private networking, resource metering and deployment controls. Object provider: request/egress behavior and signed URL conformance.

## Operating cadence

Maintain a critical-risk review, cost reconciliation, dependency upgrade batch and documentation/API review. Every incident or failed chaos test should yield an invariant/runbook update. Avoid feature planning that ignores unresolved cross-store correctness gates.

## OSS and license

Recommend Apache-2.0 for framework packages after owner/legal approval, because an explicit permissive framework license can support adoption and contributions. Keep the managed control plane as a separate licensed product if desired, without breaking self-hosted runtime usability. The archive leaves publication private/unlicensed pending that decision; it does not grant rights on the owner's behalf.

## Business safeguards

Protect runway by using managed components during validation, but track vendor concentration and export paths. Do not accept enterprise SLAs or unlimited cost obligations before reliability/capacity data. Security contact, terms, privacy/data handling, subprocessors, incident notification and support boundaries must exist before real customer data is hosted.

## Sources and evidence

- [A13: Apache 2.0 license](https://www.apache.org/licenses/LICENSE-2.0) — Recommended framework license subject to owner/legal approval; do not license owner material without approval.
- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [P02: PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing) — Instance, storage, replica and pooling costs need region/configuration-specific pricing.
- [D04: Railway resource pricing](https://railway.com/pricing) — Meter and plan source; model unverified rates as assumptions.
