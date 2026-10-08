# Cloud usage and pricing contract

`@akter/cloud-api` describes hosted usage as compute unit-hours and pooled managed database storage. Commands and reads are not metered, capped or priced, and outbound traffic is not reported. `CloudApi.billing.listPlans` returns the `PlanCatalog`, and `CloudApi.usage.get` returns an organization's `Usage` for a billing period. This document defines the shape of those responses. Prices and allowances come from the hosted pricing configuration and are not part of the contract.

## Compute units

Compute is billed in compute unit-hours. The plan catalog's `computeSizes` gives the unit weight of every machine size: each `ComputeSize` is `{ cpuKind, cpus, memoryMb, unitsPerHour }`, and one hour of that size bills `unitsPerHour` compute unit-hours. `cpuKind` is `shared` or `performance`, `cpus` and `memoryMb` are positive integers, and `unitsPerHour` is greater than zero. The weights come from the hosted pricing configuration and are not fixed by the contract. `computeSizes` is required, and may be empty.

## Storage

`storage` is the managed database storage Akter Cloud runs for an organization's environments, pooled across all of them and measured in decimal gigabytes. A database the customer brings (`byo-database`) is never measured, capped or billed, and is excluded from every storage figure.

## Plan catalog

Each `CatalogPlan` carries, all required:

| Field                              | Meaning                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `allowances.computeUnitHours`      | Included compute unit-hours per billing period, non-negative              |
| `allowances.computeUnitHourCap`    | Hard compute stop in unit-hours, or `null` when overage is billed instead |
| `allowances.storageGb`             | Included pooled managed database storage in GB, non-negative              |
| `allowances.storageGbCap`          | Hard storage stop in GB, or `null` when overage is billed instead         |
| `allowances.concurrentConnections` | Organization-wide concurrent WebSocket and SSE connections                |
| `overage.computeCentsPerUnitHour`  | Price of each compute unit-hour beyond the allowance, non-negative        |
| `overage.storageCentsPerGbMonth`   | Price of each GB-month of storage beyond the allowance, non-negative      |
| `features`                         | What the plan offers, below                                               |

`PlanFeature` is one of `compute-overage` (compute beyond the allowance is billed), `compute-cap` (compute stops at the cap), `storage-overage` (storage beyond the allowance is billed), `storage-cap` (the managed databases become read-only at the cap), `byo-database` (the plan can bring its own Postgres database), `dedicated-database` (the plan can add a dedicated managed database) and `checkout` (a paid subscription bought through checkout).

## Usage report

- `meters` are `runnerHours` and `storageGb`, each `{ meter, used, included, overage, overageCostCents }`. `runnerHours` is measured in compute unit-hours, not machine hours. `storageGb` is the average pooled managed database storage over the period in GB, billed per GB-month.
- `caps` describe the caps as the edge decides them now, whatever `period` is reported. Each `CapState` has `cap` of `spend`, `connections`, `compute` or `storage`. `limit` is `null` when the cap does not apply. `limit` and `used` are cents for `spend`, open connections for `connections`, compute unit-hours for the current billing period for `compute`, and decimal GB of pooled managed storage for `storage`, where `used` is the latest pooled sample. `atCap` means usage reached the limit. `refusing` means the edge refuses the next new command, or for `connections` the next new connection, or for `storage` that the managed databases are read-only: writes fail and reads work. `reason: "unbound"` means the organization has no billing account and the edge refuses everything.
- `latestStorageSample` is `{ bytes, sampledAt }`, the latest pooled managed database size for the organization with a BYO database excluded, or `null` before the first sample.
- Each `byProject` entry is `{ projectId, name, computeUnitHours, compute, storageGbMonths, estimatedCostCents }`. `compute` is an array of `ComputeUsage` records and is empty when the project ran no machine. `storageGbMonths` is the project's managed database storage for the period.
- A `ComputeUsage` record is `{ environmentId, cpuKind, cpus, memoryMb, machineHours, computeUnitHours }` for one machine size in one environment. `environmentId` is an opaque control-plane identifier. `cpuKind` is `shared` or `performance`. `cpus` and `memoryMb` are positive integers. `machineHours` holds the raw machine hours, and `computeUnitHours` holds the unit-hours billed for them at the size's catalog weight. Decoding refuses negative hours, a machine with no CPU or memory, fractional CPUs or memory, an unknown CPU kind and an empty environment. It does not recompute unit-hours from the machine size, because the weights belong to the pricing configuration.
- `pricing` is `{ computeCentsPerUnitHour, storageCentsPerGbMonth, provisional? }`, the published overage prices; each is `0` where the plan bills no overage.

## Quota refusals

A request refused at a hard cap fails with `QuotaExceeded`, carrying `organizationId`, `period`, `cap` (`compute`, `storage`, `connections` or `spend`), `limit` and `used` in that cap's units, and `retryAfterMs`. It is answered 429 for every cap, and a WebSocket it ends closes with 1008. It replaces the separate `SpendLimitExceeded`, `ConnectionLimitExceeded` and `StorageQuotaExceeded` errors.

`retryAfterMs` is the time until the billing period resets for `compute` and `spend`, and a short back-off for `connections`. A `connections` refusal clears as connections close, so it is the only retryable cap: the client retries it with the same command id after `retryAfterMs`. A `storage` refusal is not lifted by the period resetting; it lifts when the pooled storage drops below the cap or the organization upgrades, so `retryAfterMs` there is only a hint.

## Removed fields

Every command and read field is gone: the command allowance, cap and overage, the read weight, the `commands` and `reads` meters and the `commands` cap, `commandsPerDay`, per-project `commands` and `reads`, `freeCommands`, and the `unitsPerCommand`, `limitUnits`, `usedUnits` and `requestedUnits` of `QuotaExceeded`, and the `SpendLimitExceeded`, `ConnectionLimitExceeded` and `StorageQuotaExceeded` errors. The `egressGb` meter is gone too. No compatibility field is kept, so a client decoding an older response fails rather than silently reading zero.

`ProjectRegion` no longer reports a database `engine`, a `shardGroup` or `backups`: Akter Cloud runs Postgres only, has no shards, and promises no backups or point-in-time recovery for a managed database.
