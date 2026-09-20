# Pricing hypotheses

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Recommended commercial structure

For early managed pilots, use a platform minimum plus clearly defined usage and a capacity/abuse limit. Offer dedicated environments and support through negotiated commitments. Keep the self-hosted framework independently usable. Do not commit to unlimited dormant identities without database-count and metadata economics.

## Public meters to evaluate

Active compute; actor database storage; write/IO usage or a carefully bounded included allowance; retained blobs/events; outbound transfer; premium dedicated capacity/support. Requests may be a convenience meter but cannot hide unbounded write amplification. Internal retries caused by platform failures should not produce surprising customer charges; account for them in COGS and publish the policy.

## Avoid

Per-actor identity fees that discourage sensible modeling, but also avoid declaring all identities literally free when provider plans cap DB count. Avoid charging every internal message separately without an understandable receipt-level bill. Avoid promising margins based on future negotiated rates. Avoid comparing a bundled command to a competitor's request-only price.

## Enticing without underpricing

Sell an excellent local/self-host developer path, transparent receipts/recovery, modest onboarding minimums, predictable caps and readable cost attribution. Offer usage credits for pilots while measuring costs. Lower platform fees can help adoption, but they are not 'pure margin' once fixed control-plane/observability/support costs are included.

## Enterprise

Commitments can purchase reserved capacity, dedicated application deployments, private networking, support response and operational reviews. Price to the delivered obligations and measured resource envelope. Do not infer an Amazon-sized contract from actor-count speculation. Start with one production workload and expand based on value.

## Launch gate

Publish a rate card only after G12. The model files provide illustrative prices solely to test arithmetic and sensitivity. None is an approved offer. Record region, provider rate date, inclusions, retry policy, retention, minimums and overage/cap behavior for every published plan.

## Sources and evidence

- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [C05: Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) — Requests, duration and storage meters; not directly comparable to our internal messages.
- [C03: Rivet Cloud](https://rivet.dev/cloud/) — Managed cloud and pricing reference; historical prices not assumed current.
- [D04: Railway resource pricing](https://railway.com/pricing) — Meter and plan source; model unverified rates as assumptions.
