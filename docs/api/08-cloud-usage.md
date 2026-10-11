# Cloud usage and pricing contract

`@akter/cloud-api` describes hosted usage as compute unit-hours only. Akter Cloud hosts compute; every environment on every plan uses the customer's Postgres through `DATABASE_URL`. Database storage is not metered, capped or billed by Akter. Commands and reads have no per-use meter or price, and outbound traffic is not reported. `CloudApi.billing.listPlans` returns the `PlanCatalog`, and `CloudApi.usage.get` returns an organization's `Usage` for a billing period. This document defines the shape of those responses. Prices and allowances come from the hosted pricing configuration and are not part of the contract; the [Cloud pricing guide](/cloud/pricing-and-limits) lists them.

## Compute units

Compute is billed in compute unit-hours. The plan catalog's `computeSizes` gives the unit weight of every machine size: each `ComputeSize` is `{ cpuKind, cpus, memoryMb, unitsPerHour }`, and one hour of that size bills `unitsPerHour` compute unit-hours. `cpuKind` is `shared` or `performance`, `cpus` and `memoryMb` are positive integers, and `unitsPerHour` is greater than zero. The weights come from the hosted pricing configuration and are not fixed by the contract. `computeSizes` is required, and may be empty.

## Plan catalog

Each `CatalogPlan` carries, all required:

| Field                              | Meaning                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `allowances.computeUnitHours`      | Included compute unit-hours per billing period, non-negative              |
| `allowances.computeUnitHourCap`    | Hard compute stop in unit-hours, or `null` when overage is billed instead |
| `allowances.concurrentConnections` | Organization-wide concurrent WebSocket and SSE connections                |
| `overage.computeCentsPerUnitHour`  | Price of each compute unit-hour beyond the allowance, non-negative        |
| `features`                         | What the plan offers, below                                               |

`PlanFeature` is one of `compute-overage` (compute beyond the allowance is billed), `compute-cap` (compute stops at the cap) and `checkout` (a paid subscription bought through checkout). Customer-owned Postgres is required on every plan, not a plan feature or add-on.

## Usage report

- With no `period` query parameter, `CloudApi.usage.get` reports the current subscription renewal window for paid plans and the current UTC calendar month for Free. Included compute, current cost estimates and spend caps use that same current window. The response's `period` is a `YYYY-MM` label for the window's start, not proof that the window starts on the first day of that month. Explicit `?period=YYYY-MM` selects that UTC calendar month's usage for reporting, even for paid plans; it does not change subscription renewal boundaries or current cap enforcement. Missing or stale paid subscription-period bounds return `Unavailable` (503) while awaiting provider reconciliation, rather than falling back to a calendar month or reporting zero current spend.
- `meters` contains the `runnerHours` meter, shaped as `{ meter, used, included, overage, overageCostCents }`. `runnerHours` is measured in compute unit-hours, not raw machine hours. There is no storage meter or sample.
- `caps` describe the caps as the edge decides them now, whatever `period` is reported. Each `CapState` has `cap` of `spend`, `connections` or `compute`. `limit` is `null` when the cap does not apply. `limit` and `used` are cents for `spend`, open connections for `connections`, and compute unit-hours for the current billing period for `compute`. `atCap` means usage reached the limit. `refusing` means the edge refuses the next new command, or for `connections` the next new connection. `reason: "unbound"` means the organization has no billing account and the edge refuses everything. A compute cap does not alter the customer's database or make it read-only.
- Each `byProject` entry is `{ projectId, name, computeUnitHours, compute, estimatedCostCents }`. `compute` is an array of `ComputeUsage` records and is empty when the project ran no machine.
- A `ComputeUsage` record is `{ environmentId, cpuKind, cpus, memoryMb, machineHours, computeUnitHours }` for one machine size in one environment. `environmentId` is an opaque control-plane identifier. `cpuKind` is `shared` or `performance`. `cpus` and `memoryMb` are positive integers. `machineHours` holds the raw machine hours, and `computeUnitHours` holds the unit-hours billed for them at the size's catalog weight. Decoding refuses negative hours, a machine with no CPU or memory, fractional CPUs or memory, an unknown CPU kind and an empty environment. It does not recompute unit-hours from the machine size, because the weights belong to the pricing configuration.
- `pricing` is `{ computeCentsPerUnitHour, provisional? }`, the published compute overage price; it is `0` where the plan bills no overage. Base subscription and accrued compute overage are the only Akter charges; the customer's database-provider bill is separate.

## Quota refusals

A request refused at a hard cap fails with `QuotaExceeded`, carrying `organizationId`, `period`, `cap` (`compute`, `connections` or `spend`), `limit` and `used` in that cap's units, and `retryAfterMs`. It is answered 429 for every cap, and a WebSocket it ends closes with 1008. It replaces the separate `SpendLimitExceeded`, `ConnectionLimitExceeded` and `StorageQuotaExceeded` errors.

`retryAfterMs` is the time until the billing period resets for `compute` and `spend`, and a short back-off for `connections`. A `connections` refusal clears as connections close, so it is the only retryable cap: the client retries it with the same command id after `retryAfterMs`.

## Removed fields

Every command and read field is gone: the command allowance, cap and overage, the read weight, the `commands` and `reads` meters and the `commands` cap, `commandsPerDay`, per-project `commands` and `reads`, `freeCommands`, and the `unitsPerCommand`, `limitUnits`, `usedUnits` and `requestedUnits` of `QuotaExceeded`, and the `SpendLimitExceeded`, `ConnectionLimitExceeded` and `StorageQuotaExceeded` errors. The `egressGb` meter is gone too. No compatibility field is kept, so a client decoding an older response fails rather than silently reading zero.

The compute-only contract also removes `allowances.storageGb`, `allowances.storageGbCap`, `overage.storageCentsPerGbMonth`, the `storageGb` meter, the `storage` cap, `latestStorageSample`, per-project `storageGbMonths` and `pricing.storageCentsPerGbMonth`. `PlanFeature` no longer includes `storage-overage`, `storage-cap`, `byo-database` or `dedicated-database`. These are removed, not retained as zero-valued compatibility fields.

`ProjectRegion` no longer reports a database `engine`, a `shardGroup` or `backups`. Cloud uses customer-owned Postgres only; database administration, backups and point-in-time recovery belong to the customer and their provider.
