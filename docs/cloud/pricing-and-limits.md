---
title: "Pricing, limits and billing"
description: "Pay a base subscription plus compute unit-hours; your Postgres bill stays with your provider."
---

Akter Cloud bills **base subscription + compute unit-hours only**. It does not provide or bill for databases or storage. Every environment on every plan needs [your own Postgres](/cloud/database), which you pay for separately with your database provider.

Prices below are in USD. Included compute is pooled per organization across its projects and environments, not allotted once per project. Commands and reads have **no per-use charge**, seats are unlimited on every plan, and egress is not billed at launch.

## Plans

| Plan       | Monthly base | Included compute unit-hours | Compute overage / unit-hour | Concurrent realtime connections |
| ---------- | ------------ | --------------------------- | --------------------------- | ------------------------------- |
| Free       | $0           | 750, hard cap               | None; runner stops at cap   | 100                             |
| Pro        | $25          | 1,500                       | $0.015                      | 5,000                           |
| Team       | $249         | 16,000                      | $0.015                      | 50,000                          |
| Enterprise | $2,500       | 160,000                     | $0.015                      | 100,000                         |

Free does not require a paid subscription, and its runner sleeps when idle. Current abuse-policy defaults additionally allow 3 owned organizations per user, 2 projects per Free organization and 20 Free deployment admissions per organization per day. These are operator-configured admission limits. Refusals identify the applicable limit and direct you to upgrade or contact `support@akter.dev`.

## Compute unit-hours

One compute unit-hour is one running hour of the default runner: **shared 1 vCPU / 512 MB**. At launch this is the only size provisioned. Multiple runners' running time adds together: two default runners running for an hour use two unit-hours. A sleeping runner does not accrue running hours.

Compute beyond a paid allowance is billed at **\$0.015 per unit-hour**. For example, a Pro organization using 1,620 unit-hours owes its \$25 base plus 120 overage unit-hours at \$0.015: **\$26.80 for Akter**, before taxes and excluding its separate database-provider bill.

Larger runner sizes are coming, not available at launch. Their unit weights are:

| Runner size               | Compute units per running hour | Launch availability |
| ------------------------- | ------------------------------ | ------------------- |
| Shared 1 vCPU / 512 MB    | 1                              | Available; default  |
| Shared 1 vCPU / 1 GB      | 2                              | Coming              |
| Shared 2 vCPU / 2 GB      | 4                              | Coming              |
| Shared 4 vCPU / 4 GB      | 8                              | Coming              |
| Performance 1 vCPU / 2 GB | 9                              | Coming              |
| Performance 2 vCPU / 4 GB | 18                             | Coming              |
| Performance 4 vCPU / 8 GB | 36                             | Coming              |

## Connections

WebSocket and SSE connections share one organization-wide concurrency cap; reaching it refuses new connections rather than charging connection overage. These realtime connections are distinct from your database's Postgres connection budget. The [deploy-time database probe](/cloud/database#deploy-time-checks) caps runners at the available Postgres capacity; paying for more compute does not remove that ceiling.

Periods are UTC calendar months. Use organization settings **Usage** to review your compute usage and cap states. For usage response fields and machine-size weights, see the [Cloud usage API reference](/api/08-cloud-usage).

## When Free reaches its compute cap

Free's **750 compute unit-hours are a hard cap**, with no billed overage. At that cap, runners stop and new commands are refused until the next billing period or you upgrade. Idle sleep reduces compute use; it does not delete data from your Postgres database.

There is **no Akter database-size allowance, storage cap or storage charge**, on Free or any other plan. Akter does not make your database read-only when compute runs out. Your database provider's own limits and charges still apply.

## Billing and spend caps

Use organization settings **Billing** to select a paid plan, open Stripe's billing portal, manage payment details and view invoices. Billing mutations require an owner or admin, not a project-restricted API key. A plan change invoices immediately and can remain pending while payment confirmation is incomplete.

Set a spend limit in Billing to refuse new admissions whose projected period cost would exceed it. The projection includes the subscribed plan's base charge and accrued compute overage only, not your database-provider bill. Removing the limit permits admissions without that spend ceiling.

A spend limit is an admission control, **not a guarantee that the final invoice cannot exceed it**. It does not clip accrued charges or cancel work already admitted. Free's compute hard stop is a separate rule. A new organization awaiting billing initialization has no bound plan yet and cannot admit metered traffic; it is not silently treated as Free.
