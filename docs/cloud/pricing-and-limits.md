---
title: "Pricing, limits and billing"
description: "Current plan configuration, Free caps and how spend limits work."
---

<Warning>
Paid prices below are the current billing-code defaults, not confirmed launch prices. Pro, Team and Enterprise remain provisional pending pricing confirmation. Check the console's active catalog before purchasing; live production refuses provisional paid prices.
</Warning>

## Current plan configuration

Prices are in USD. Monthly command allowances apply once per organization across its projects, not once per project.

| Plan                     | Monthly base | Included command equivalents | Included storage | Concurrent realtime connections | Command overage / million | Storage overage / GB-month     |
| ------------------------ | ------------ | ---------------------------- | ---------------- | ------------------------------- | ------------------------- | ------------------------------ |
| Free                     | $0           | 1,000,000                    | 0.5 GB           | 100                             | Hard cap; no overage      | Hard admission cap; no overage |
| Pro (provisional)        | $25          | 25,000,000                   | 10 GB            | 5,000                           | $1.00                     | $0.30                          |
| Team (provisional)       | $249         | 300,000,000                  | 100 GB           | 50,000                          | $0.60                     | $0.30                          |
| Enterprise (provisional) | $2,500       | 5,000,000,000                | 1,000 GB         | 100,000                         | $0.50                     | $0.30                          |

Free does not require a paid subscription. Current abuse-policy defaults additionally allow 3 organizations per user, 2 projects per Free organization and 20 Free deployments per organization per day. These are operator-configured admission limits; refusals identify the applicable limit and direct you to upgrade or contact `support@akter.dev`.

## What counts as usage

A command weighs one command equivalent; a completed read weighs 0.2. Both draw from the same allowance. Replaying a stored command receipt adds no command usage. Application failures that commit receipts still count. A watch's first read counts; its reruns and realtime messages do not add further read usage.

Periods are UTC calendar months. Storage is sampled hourly as attributable logical row bytes and normalized into decimal GB-months using the actual hours in that month. Physical disk, indexes and bloat are not billed. A missing sample is unknown, not evidence of zero usage. The console reports usage, per-project variable-cost estimates and the latest storage sample time; the organization's base subscription is not allocated to those project estimates.

## When Free reaches a cap

The command-equivalent cap refuses new edge admissions. The storage admission cap refuses new commands when a serving deployment tenant's latest sample is at or above 500,000,000 bytes; reads and existing reservations remain allowed. A later below-cap sample reopens command admission. The storage check uses the latest sample, not the size a new command is predicted to create, so growth can overshoot between hourly samples. Free storage overage is not billed.

WebSocket and SSE connections share one organization-wide concurrency cap. Reaching it refuses new connections. Work already admitted, including jobs, timers and internal turns, can finish even after a command or spend cap is reached.

## Billing and spend caps

Use organization settings **Billing** to select an available paid plan, open Stripe's billing portal, manage payment details and view invoices. Billing mutations require an owner or admin, not a project-restricted API key. A plan change invoices immediately and can remain pending while payment confirmation is incomplete.

Set a spend limit in Billing to refuse new admissions whose projected period cost would exceed it. The projection includes the subscribed plan's base charge and accrued command and storage usage. Removing the limit permits admissions without that spend ceiling.

A spend limit is an admission control, **not a guarantee that the final invoice cannot exceed it**. Already admitted work continues, usage is sampled and reconciled, and accrued charges are not clipped to the cap. Check **Usage** for current cap states and sampling times as well as the spend estimate. A new organization awaiting billing initialization has no bound plan yet and cannot admit metered traffic; it is not silently treated as Free.
