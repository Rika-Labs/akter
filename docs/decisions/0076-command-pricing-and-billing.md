# ADR 0076: Committed-command pricing, metering and billing

**Status:** accepted (2026-10-03). Records Dallen's pricing decisions for issues #515–#518. Paid prices remain provisional until the Neki fleet benchmark.

**Responsibility:** define the units Akter Cloud bills, their authority, and the separation between pricing, billing and admission.

**Authority:** design decision record.

**Owner role:** cloud/billing.

**Change policy:** changes to chargeable units, billing-evidence retention or cap semantics require a superseding decision and failure-path evidence.

## Decision

### Units and tiers

A newly committed command receipt costs one command unit. A replay of that receipt costs nothing. A terminal declared failure which commits a receipt counts; an authorization refusal, conflict, expired identity or transaction rollback without a committed receipt does not. Internal commands count when they commit receipts. Realtime messages themselves are free.

A completed query costs 0.2 command units. Accounting uses integer fifths of a command, so five reads equal one command without floating-point drift. Monthly allowances and overages combine commands and weighted reads. Durable storage costs $0.30 per decimal GB-month above the tier's allowance; hourly byte samples are integrated over the actual number of hours in the UTC billing month. Retrying a sample must not charge its bytes again.

The Free tier includes 1,000,000 command units per UTC calendar month, as a hard cap. It has no paid command overage. Realtime is limited by concurrent connections, including SSE and WebSocket sessions, rather than by message volume.

Pricing and entitlements are configuration, not commercial offers embedded in handlers. Research section 7.2 supplies only these planning defaults:

| Tier       | Base/month          | Included commands | Overage/million    | Storage included | Concurrent connections |
| ---------- | ------------------- | ----------------- | ------------------ | ---------------- | ---------------------- |
| Free       | $0                  | 1M, hard cap      | none               | 0.5 GB           | 100                    |
| Pro        | $25, provisional    | 25M               | $1.00, provisional | 10 GB            | 5,000                  |
| Team       | $249, provisional   | 300M              | $0.60, provisional | 100 GB           | 50,000                 |
| Enterprise | $2,500, provisional | 5B                | $0.50, provisional | 1,000 GB         | operator configured    |

The default Enterprise connection cap is 100,000 for local verification, not a commercial promise. Paid values are not published offers. The research's optional Enterprise volume discount above 20B is not implemented by the default configuration. A Neki fleet benchmark and an explicit pricing configuration are required before publicly offering paid plans.

### Meter authority and delivery

The receipt transaction is the command meter's authority, never an HTTP status, trace, process counter or eventually scanned list of retained receipts. Meter evidence outlives receipt pruning. Read accounting runs in the query path before returning its result; a lost reply does not undo a completed read.

The framework exposes an optional `UsageAccounting` transaction capability, not billing tables or a provider dependency. `@akter/metering` installs control-plane-owned tables on the hosted cell through idempotent startup migrations; no framework migration is needed. `@akter/billing` owns the provider boundary and pricing. `apps/api` owns billing, usage and collector actors. A metered database/schema has one deployment owner; attribution across a shared schema remains unsupported until its isolation model is verified. These are new reusable workspace packages under the repository structure rules.

The control plane durably binds each hosted deployment/tenant to its organization and project. Client tenant claims cannot select the billing organization. Cell evidence is imported idempotently and rolled up into hourly tenant/project aggregates. A collector crash before or after import must yield the same totals. An hourly export is immutable once sealed; late evidence cannot silently change a previously exported Stripe event.

Usage metering and billing synchronization run as Akter actors. Provider calls run in jobs after the actor transaction, with identities independent of attempts. Stripe meter event streams receive at most 100 events per request. An event's identity derives from tenant, meter and UTC hour; an ambiguous success followed by a crash reuses exactly that identity and value. Its accepted response and export checkpoint are durable. An outage beyond Stripe's deduplication horizon requires reconciliation, not an assumption of indefinite provider deduplication.

### Stripe and local execution

Stripe is accessed only through an Effect service backed by `@distilled.cloud/stripe` at `1.0.0-rc.13`. Products, meters and tier prices have deterministic setup identities. Subscription checkout enables Stripe Tax; portal sessions use server-built return URLs. A setup command provisions the catalog rather than making vendor calls inside an actor turn.

Stripe's portal cannot update usage-based subscriptions with this base-plus-meter-price shape. A controlled subscription-change job replaces the existing subscription's tier items under a stable request identity and reconciles canonical state; it never creates a second subscription or grants the requested tier before payment/provider state permits it. The managed portal configuration handles billing details, tax IDs, payment methods, invoice history and cancellation. Checkout lifecycles prevent concurrent initial sessions from creating duplicate subscriptions.

Webhooks are verified against their exact raw bytes with Stripe's signature helpers before any update. Durable event identities make retries no-ops. Billing synchronization reads canonical provider subscription state rather than accepting out-of-order snapshots as current authority. Customer and subscription identities must match the recorded organization binding before entitlements change. Plan and entitlements commit together. Failed payment removes paid entitlements according to the configured policy.

The local development stack uses a SQL-backed local Stripe service, creates no real provider objects and needs no real credentials. Fake-HTTP tests exercise the Distilled adapter's wire boundary. These tests are not evidence of real Stripe delivery, tax registration, Neki locality or a production benchmark.

### Caps

The edge checks the organization's current entitlements and durable usage/reservations before forwarding. Free admission reserves capacity so concurrent edges cannot spend the same remaining allowance while hourly collection lags. A command replay reuses its reservation identity and needs no new capacity. Ambiguous requests retain their reservation until durable evidence reconciles them; losing an edge must not reopen the cap.

Paid organizations can set a nullable monthly spend limit. Admission estimates the next unit using the same configured price rules as usage reporting. Concurrent connections use organization-wide durable leases. A connection whose lease cannot be renewed is closed before it can continue after expiry. Unknown billing bindings fail closed.

Quota, spend-limit and connection-limit refusals have distinct typed reasons and are not committed receipts or billable reads. The cloud API exposes plan, payment method, invoices, spend limit, used/included/overage units, daily committed commands and project usage/cost estimates, and identifies provisional paid pricing.

## Alternatives

- Edge response counters cannot distinguish replays or lost responses from new commits and are rejected.
- Scanning retained receipts loses evidence through pruning and cannot safely use a sequence watermark across concurrent commits.
- Floating-point read counters, process-local caps and expiring ambiguous reservations can overshoot hard caps and are rejected.
- Vendor SDKs, Better Auth's Stripe plugin and real credentials in local verification are rejected.

## Verification required

Tests must reject rollback charges, replay charges, lost commits during collection, duplicate provider usage after an ambiguous flush, forged or cross-customer webhooks, stale cancellation reversals, cap races across edges and leaked connections after disconnect or lease loss. Real local Postgres is required for transaction and concurrency evidence. Production provider support remains unknown until credentialed Stripe sandbox and Neki fleet verification are recorded.
