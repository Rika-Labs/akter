# Cloud usage and compute pricing contract

`@akter/cloud-api` describes hosted usage as commands, compute and outbound traffic. Compute replaces storage as the priced resource meter. `CloudApi.billing.listPlans` returns the `PlanCatalog`, and `CloudApi.usage.get` returns an organization's `Usage` for a billing period. This document defines the shape of those responses. Prices and allowances come from the hosted pricing configuration and are not part of the contract.

## Compute units

A compute unit-hour is one hour of one shared CPU with 256 MiB of memory. A machine hour weighs

```text
max(cpus × (cpuKind = performance ? 4 : 1), memoryMb ÷ 256)
```

units, so a shared 1 CPU, 1024 MiB machine weighs 4 and a performance 2 CPU, 4096 MiB machine weighs 16. The weight depends only on machine size. It does not depend on what the runner does with the machine.

## Plan catalog

Each `CatalogPlan` carries:

| Field                             | Meaning                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `allowances.computeUnitHours`     | Included compute unit-hours per billing period, non-negative              |
| `allowances.computeUnitHourCap`   | Hard compute stop in unit-hours, or `null` when overage is billed instead |
| `overage.computeCentsPerUnitHour` | Price of each unit-hour beyond the allowance, non-negative                |
| `features` `compute-overage`      | Compute beyond the allowance is billed                                    |
| `features` `compute-cap`          | Compute stops at the cap                                                  |

The command allowance, command cap, concurrent connections and command overage are unchanged.

## Usage report

- The `runnerHours` meter is measured in compute unit-hours, not machine hours. The `egressGb` meter is outbound traffic in decimal gigabytes.
- `UsagePricing.computeCentsPerUnitHour` is the published compute overage price.
- A `CapState` with `cap: "compute"` reports `limit` and `used` in compute unit-hours for the current billing period.
- Each `byProject` entry may carry `computeUnitHours`, the project's compute for the period, and `compute`, an array of `ComputeUsage` records. Both are omitted for a project whose compute is not metered.
- A `ComputeUsage` record is `{ environmentId, cpuKind, cpus, memoryMb, machineHours, computeUnitHours }` for one machine size in one environment. `environmentId` is an opaque control-plane identifier. `cpuKind` is `shared` or `performance`. `cpus` and `memoryMb` are positive integers. `machineHours` holds the raw machine hours, and `computeUnitHours` holds the same hours normalized by the weight above. Decoding refuses negative hours, a machine with no CPU or memory, fractional CPUs or memory, an unknown CPU kind, and a record whose unit-hours disagree with its weight beyond floating-point rounding.

## Deprecated storage fields

The server no longer reports storage. These fields and values stay optional or decodable so clients reading older responses keep working, and new servers emit none of them:

- `CatalogPlan.allowances.storageGb` and `CatalogPlan.overage.storageCentsPerGbMonth`;
- the `storage-overage` and `storage-cap` plan features;
- the `storage` cap and the `storageGb` meter;
- `Usage.latestStorageSample`, a project's `storageGbMonths`, and `UsagePricing.storagePerGbCents`.

The compute fields in the plan catalog and usage pricing are required, so a response with only the storage-era fields does not decode.
