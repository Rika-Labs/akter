---
title: "Pricing, limits and billing"
description: "Plans, compute unit-hours, database size and spend caps."
---

Akter Cloud bills a base price, compute unit-hours and database size. There are no per-command or per-read charges. Akter creates and runs a [database](/cloud/database) for each environment, included up to your plan's database size. Prices below are in USD; compute and database allowances apply once per organization across its projects and environments, not once per project. Seats are unlimited on every plan, and egress is not billed at launch.

## Plans

| Plan       | Monthly base | Included compute unit-hours | Included database size  | Concurrent realtime connections | Bring your own Postgres |
| ---------- | ------------ | --------------------------- | ----------------------- | ------------------------------- | ----------------------- |
| Free       | $0           | 750, hard cap               | 0.5 GB, hard cap        | 100                             | No                      |
| Pro        | $25          | 1,500                       | 10 GB                   | 5,000                           | No                      |
| Team       | $249         | 16,000                      | 50 GB; dedicated add-on | 50,000                          | Yes                     |
| Enterprise | From $2,500  | 160,000                     | Custom                  | 100,000                         | Yes                     |

| Plan       | Compute overage / unit-hour         | Database overage / GB-month |
| ---------- | ----------------------------------- | --------------------------- |
| Free       | No overage; runner stops at the cap | No overage; hard cap        |
| Pro        | $0.015                              | $0.50                       |
| Team       | $0.015                              | $0.50                       |
| Enterprise | $0.015 list rate                    | Custom                      |

Free does not require a paid subscription, and its runner sleeps when idle. Current abuse-policy defaults additionally allow 3 owned organizations per user, 2 projects per Free organization and 20 Free deployment admissions per organization per day. These are operator-configured admission limits. Refusals identify the applicable limit and direct you to upgrade or contact `support@akter.dev`.

## Compute unit-hours

One compute unit-hour is one hour of the default runner: **shared 1 vCPU / 512 MB**. At launch this is the only size provisioned. Multiple runners' running time adds together; for example, two default runners running for an hour use two unit-hours.

Compute beyond a paid allowance is billed at **$0.015 per unit-hour** at the list rate. Larger runner sizes are coming, not available at launch. Their unit weights are:

| Runner size               | Compute units per running hour | Launch availability |
| ------------------------- | ------------------------------ | ------------------- |
| Shared 1 vCPU / 512 MB    | 1                              | Available; default  |
| Shared 1 vCPU / 1 GB      | 2                              | Coming              |
| Shared 2 vCPU / 2 GB      | 4                              | Coming              |
| Shared 4 vCPU / 4 GB      | 8                              | Coming              |
| Performance 1 vCPU / 2 GB | 9                              | Coming              |
| Performance 2 vCPU / 4 GB | 18                             | Coming              |
| Performance 4 vCPU / 8 GB | 36                             | Coming              |

## Database size

Included database size is pooled across all of your organization's managed environment databases, like compute hours, not allotted per environment. Akter measures their combined size. Pro and Team are billed **$0.50 per GB-month** beyond the included size. Free's 0.5 GB is a hard cap with no overage, and Enterprise databases are sized to your agreement. Team can add a dedicated database.

On Team and Enterprise you can [bring your own Postgres](/cloud/bring-your-database) instead. Akter never bills or caps the size of a database you bring; you pay your own database provider for it separately, and it does not count toward the pooled allowance.

## Connections

Commands and reads carry no per-use charge. WebSocket and SSE connections share one organization-wide concurrency cap; reaching it refuses new connections rather than charging connection overage.

Periods are UTC calendar months. Use organization settings **Usage** to review your compute usage and cap states. For usage response fields and machine-size weights, see the [Cloud usage API reference](/api/08-cloud-usage).

## When Free reaches a cap

Free's **750 compute unit-hour allowance is a hard cap**. At that cap, the runner stops and new commands are refused until the next billing period. Free's 0.5 GB database allowance is also a hard cap rather than a billed overage. When your organization's managed databases reach it, they become read-only: writes fail and reads still work, until usage drops below the cap or you upgrade. Upgrade your plan if you need usage beyond the Free allowances.

## Billing and spend caps

Use organization settings **Billing** to select a paid plan, open Stripe's billing portal, manage payment details and view invoices. Billing mutations require an owner or admin, not a project-restricted API key. A plan change invoices immediately and can remain pending while payment confirmation is incomplete.

Set a spend limit in Billing to refuse new admissions whose projected period cost would exceed it. The projection includes the subscribed plan's base charge and accrued compute and database-size overage. Removing the limit permits admissions without that spend ceiling.

A spend limit is an admission control, **not a guarantee that the final invoice cannot exceed it**. It does not clip accrued charges or cancel work already admitted. Free's compute hard stop is a separate rule. A new organization awaiting billing initialization has no bound plan yet and cannot admit metered traffic; it is not silently treated as Free.
