---
title: "Cloud usage API"
sidebarTitle: "Cloud usage"
description: "Read the Akter Cloud plan catalog and an organization's usage and caps over HTTP."
---

# Cloud usage API

Two read operations describe what a plan includes and what an organization has used. `@rikalabs/akter-cli/cloud-api` exports the schemas and the `CloudApi` client. Decode responses with the schemas from the version of the package you have installed.

| Client operation    | HTTP route                                     |
| ------------------- | ---------------------------------------------- |
| `billing.listPlans` | `GET /api/billing/plans`                       |
| `usage.get`         | `GET /api/organizations/:organizationId/usage` |

Send a session or an API key, as for the other cloud routes. For what each plan includes and costs, see [Pricing and limits](../cloud/pricing-and-limits.md).

## Plan catalog

`listPlans` returns `{ plans, computeSizes, provisional }`.

Each plan has an `id` (`free`, `pro`, `team`, or `enterprise`), a `name`, a `basePriceCents`, and a `currency` of `usd`. Its `allowances` hold `computeUnitHours`, `computeUnitHourCap`, and `concurrentConnections`. `computeUnitHourCap` is a number when the plan stops at an allowance and `null` when it bills extra compute at `overage.computeCentsPerUnitHour`. Its `features` list names what the plan offers. `provisional` is `true` for a plan whose prices are not final, and the top-level `provisional` is `true` while any plan is.

`computeSizes` lists every runner size with its `cpuKind` (`shared` or `performance`), `cpus`, `memoryMb`, and `unitsPerHour`: an hour of that size counts as that many compute unit-hours.

## Usage

`usage.get` returns usage for one billing period. Pass `period=YYYY-MM` to read a past UTC calendar month. The response holds:

| Field       | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `period`    | The period the numbers cover                                                                                 |
| `meters`    | One entry per meter with `used`, `included`, `overage`, and `overageCostCents`                               |
| `caps`      | The organization's caps as they stand now                                                                    |
| `byProject` | Each project's compute unit-hours, its usage by environment and machine size, and an estimated cost in cents |
| `pricing`   | The rate that prices extra compute, in cents per unit-hour                                                   |

In this version of the contract, the one meter is `runnerHours`, and it counts compute unit-hours, not machine hours. Raw machine hours are reported for each environment and size in `byProject[].compute[].machineHours`, next to the unit-hours they are billed as.

Each cap has a name (`spend`, `connections`, or `compute`), a `limit`, the amount `used`, and two flags. `atCap` means usage has reached the limit. `refusing` means the edge would refuse the next new command, or for `connections` the next new connection. `limit` is `null` when the cap does not apply. The units are cents for `spend`, open connections for `connections`, and compute unit-hours in the current billing period for `compute`. Caps always describe the present, whichever `period` you ask for.

An organization with no billing account has an `unbound` plan. Its caps carry `reason: "unbound"` and refuse everything, and it is never reported as Free.

## Errors

`usage.get` can answer 401 `Unauthorized`, 403 `Forbidden`, 404 `NotFound`, 501 `NotImplemented`, and 503 `Unavailable`. Treat a failed read as unknown usage, never as zero.
