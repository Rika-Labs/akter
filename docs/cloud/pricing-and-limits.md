---
title: "Pricing and limits"
description: "What each Akter Cloud plan includes, what extra usage costs, and the limits that apply to every app."
---

# Pricing and limits

Akter Cloud bills a monthly base price for the plan, plus usage beyond what the plan includes. Self-hosting is free: the framework is Apache-2.0, and you pay only for your own bucket and machines.

Prices are in US dollars.

## Plans

|                                 | Free              | Pro       | Team       | Enterprise  |
| ------------------------------- | ----------------- | --------- | ---------- | ----------- |
| Base price per month            | $0                | $25       | $249       | $2,500      |
| Compute unit-hours included     | 750, hard cap     | 1,500     | 16,000     | 160,000     |
| Each extra compute unit-hour    | Not available     | $0.015    | $0.015     | $0.015      |
| Concurrent connections          | 100               | 5,000     | 50,000     | 100,000     |
| Actions included per month      | 250,000, hard cap | 2,000,000 | 25,000,000 | 250,000,000 |
| Extra actions, per million      | Not available     | $10       | $10        | $8          |
| Stored data included            | 1 GB, hard cap    | 10 GB     | 100 GB     | 1,000 GB    |
| Extra stored data, per GB-month | Not available     | $0.20     | $0.20      | $0.15       |
| History included                | 1 GB, hard cap    | 10 GB     | 100 GB     | 1,000 GB    |
| Extra history, per GB-month     | Not available     | $0.10     | $0.10      | $0.08       |
| History kept for                | 7 days            | 30 days   | 30 days    | 30 days     |

A hard cap is a stop, not a charge: when a Free organization reaches one, Akter refuses further work instead of billing for it. At the compute cap, runners stop and new traffic is refused until the next month. Your data stays in the store.

## What is metered

- **Compute** is measured in unit-hours. Every hour a runner runs counts as the units its size weighs, and runners sleep when idle. The sizes are below.
- **Actions** are the actions your actors commit.
- **Stored data** is the data your actors keep in the environment store.
- **History** is retained history beyond the live data. How long it is kept depends on your plan.
- **Job seconds** are the wall-clock seconds of your job attempts. They are counted but not billed.

Views, reads, and watches are not metered.

| Runner size               | Compute units per hour |
| ------------------------- | ---------------------- |
| Shared, 1 CPU, 512 MB     | 1                      |
| Shared, 1 CPU, 1 GB       | 2                      |
| Shared, 2 CPUs, 2 GB      | 4                      |
| Shared, 4 CPUs, 4 GB      | 8                      |
| Performance, 1 CPU, 2 GB  | 9                      |
| Performance, 2 CPUs, 4 GB | 18                     |
| Performance, 4 CPUs, 8 GB | 36                     |

## Spend limit

You can set a monthly spend limit for your organization in the console. When spending reaches the limit, new requests are refused at the edge. Work that was already admitted is allowed to finish, so a limit does not guarantee an exact final bill.

## Limits in the framework

These limits belong to Akter itself and apply on every plan and when you self-host:

- An actor's state, apart from its lists, can be at most 256 KiB. Lists keep their items in pages.
- `find` returns ids and returns at most 1,000 per query.
- A command id is remembered for ten minutes, so a retry within that time returns the stored result.

## Not included

Akter Cloud does not accept a bucket you bring yourself, and it does not offer multi-region storage or point-in-time restore. If you need your own bucket, [self-host](../operations/self-host.md).

For the plan catalog and your usage as data, see the [usage API](../api/08-cloud-usage.md).
