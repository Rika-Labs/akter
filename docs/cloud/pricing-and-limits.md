---
title: "Pricing, limits and billing"
description: "Confirmed launch plans, compute unit-hours, command allowances and spend caps."
---

Akter Cloud bills runner compute and command usage. You bring and pay for [your own database](/cloud/database). Prices below are in USD; allowances apply once per organization across its projects and environments, not once per project. Seats are unlimited on every plan, and egress is not billed at launch.

## Plans

| Plan       | Monthly base | Included compute unit-hours | Included command equivalents | Concurrent realtime connections | Compute overage / unit-hour         | Command overage / million |
| ---------- | ------------ | --------------------------- | ---------------------------- | ------------------------------- | ----------------------------------- | ------------------------- |
| Free       | $0           | 750, hard cap               | 1,000,000, hard cap          | 100                             | No overage; runner stops at the cap | No overage                |
| Pro        | $25          | 1,500                       | 25,000,000                   | 5,000                           | 1.5¢                                | $1.00                     |
| Team       | $249         | 16,000                      | 300,000,000                  | 50,000                          | 1.5¢                                | $0.60                     |
| Enterprise | From $2,500  | 160,000                     | 5,000,000,000                | 100,000                         | 1.5¢ list rate                      | $0.50                     |

Free does not require a paid subscription. Current abuse-policy defaults additionally allow 3 owned organizations per user, 2 projects per Free organization and 20 Free deployment admissions per organization per day. These are operator-configured admission limits. Refusals identify the applicable limit and direct you to upgrade or contact `support@akter.dev`.

## Compute unit-hours

One compute unit-hour is one hour of the default runner: **shared 1 vCPU / 512 MB**. At launch this is the only size provisioned. Multiple runners' running time adds together; for example, two default runners running for an hour use two unit-hours.

Compute beyond a paid allowance is billed at **1.5¢ ($0.015) per unit-hour** at the list rate. Larger runner sizes are coming, not available at launch. Their unit weights are:

| Runner size               | Compute units per running hour | Launch availability |
| ------------------------- | ------------------------------ | ------------------- |
| Shared 1 vCPU / 512 MB    | 1                              | Available; default  |
| Shared 1 vCPU / 1 GB      | 2                              | Coming              |
| Shared 2 vCPU / 2 GB      | 4                              | Coming              |
| Shared 4 vCPU / 4 GB      | 8                              | Coming              |
| Performance 1 vCPU / 2 GB | 9                              | Coming              |
| Performance 2 vCPU / 4 GB | 18                             | Coming              |
| Performance 4 vCPU / 8 GB | 36                             | Coming              |

## Commands and connections

A command weighs one command equivalent; a read weighs 0.2. Both draw from the same command allowance. WebSocket and SSE connections share one organization-wide concurrency cap; reaching it refuses new connections rather than charging connection overage.

Periods are UTC calendar months. Use organization settings **Usage** to review your compute and command usage and cap states. For usage response fields and machine-size weights, see the [Cloud usage API reference](/api/08-cloud-usage).

## When Free reaches a cap

Free's command allowance is a hard cap: new commands are refused after it is exhausted. Free's **750 compute unit-hour allowance is also a hard cap**. At that compute cap, the runner stops and new commands are refused until the next billing period. Your customer-owned database is not touched. Upgrade your plan if you need usage beyond the Free allowances.

## Billing and spend caps

Use organization settings **Billing** to select a paid plan, open Stripe's billing portal, manage payment details and view invoices. Billing mutations require an owner or admin, not a project-restricted API key. A plan change invoices immediately and can remain pending while payment confirmation is incomplete.

Set a spend limit in Billing to refuse new admissions whose projected period cost would exceed it. The projection includes the subscribed plan's base charge and accrued command and compute usage. Removing the limit permits admissions without that spend ceiling.

A spend limit is an admission control, **not a guarantee that the final invoice cannot exceed it**. It does not clip accrued charges or cancel work already admitted. Free's compute hard stop is a separate rule. A new organization awaiting billing initialization has no bound plan yet and cannot admit metered traffic; it is not silently treated as Free.
