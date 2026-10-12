# Store provider support matrix

**Responsibility:** name each object-storage provider the 0.2 `Store` supports, with the date and version of its passing `akter storage check` run.  
**Authority:** verification evidence for the [storage contract](../contracts/06-storage.md#supported-providers) and [ADR 0136](../decisions/0136-stores-the-bucket-is-the-store.md).  
**Owner role:** storage and runtime.  
**Change policy:** a row changes only with a new `akter storage check` run on that provider, recorded here with its date and version. A simulator, file-system or MinIO result is never entered as another provider's result.

A provider is supported for Akter stores only while `akter storage check` passes on it. The command runs `Store.check`'s six probes against a bucket and prints each verdict with its measured numbers; see the [CLI page](../api/06-cli.md#akter-storage-check) for flags and environment variables.

| Probe                               | Property it establishes                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `conditional create race`           | Concurrent `PUT` with `If-None-Match: *` to one key yields exactly one success per round, and the stored bytes are the winner's.            |
| `compare-and-swap race`             | Concurrent `PUT` with `If-Match` on one ETag yields at most one success per round, and the stored bytes are the winner's.                   |
| `list after write`                  | A created key is listed by the next listing, and a deleted key is gone from it.                                                             |
| `overwrite refreshes last-modified` | A plain `PUT` of identical bytes moves last-modified forward; garbage collection's grace period relies on it.                               |
| `per-key write rate`                | Back-to-back writes to one key are accepted or throttled (429, 503) and never fail otherwise; the throttled count is recorded, not bounded. |
| `batch delete`                      | One multi-key delete removes every key.                                                                                                     |

## Matrix

| Provider                        | Status                                        | Date       | Version                                                                                                                                                         | Result                                    | Evidence                                                                                        |
| ------------------------------- | --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| MinIO (one node, one container) | passes locally and in CI; self-host reference | 2026-10-12 | MinIO RELEASE.2026-09-22T19-25-18Z (`cgr.dev/chainguard/minio`, digest in `packages/akter/compose.yaml`); `akter storage check` 0.2.0 (E7 change, before merge) | 6 of 6 probes pass; see the numbers below | [MinIO run](#minio-run-2026-10-12); CI runs the same probe in the `framework-integration` shard |
| Cloudflare R2                   | not established                               |            |                                                                                                                                                                 |                                           | [Slot](#cloudflare-r2)                                                                          |
| Tigris                          | not established                               |            |                                                                                                                                                                 |                                           | [Slot](#tigris)                                                                                 |
| AWS S3                          | not established                               |            |                                                                                                                                                                 |                                           | [Slot](#aws-s3)                                                                                 |

"Not established" means no run exists: it does not mean the provider fails. The adapter's handling of AWS's `409` for a concurrent conditional write is from the provider's documentation, not from a test.

## MinIO run, 2026-10-12

One MinIO node in a local container (`docker compose -f packages/akter/compose.yaml up --wait`), reached over loopback. The numbers describe that setup only.

```text
akter storage check 0.2.0, 2026-10-12T21:59:21.703Z
Target: S3 bucket cli-check, endpoint http://127.0.0.1:9000, region us-east-1

PASS  conditional create race (986 ms)
      16 writers x 10 rounds: 0 rounds with two successful creators, 0 winners not stored, 0 unanswered writes
PASS  compare-and-swap race (889 ms)
      16 writers x 10 rounds: 0 rounds with two successful swaps, 0 winners not stored, 0 unanswered writes
PASS  list after write (76 ms)
      10 rounds: 0 created keys missing from the next listing, 0 deleted keys still listed
PASS  overwrite refreshes last-modified (2020 ms)
      a plain PUT of identical bytes 2000 ms after the first moved last-modified by 2000 ms
PASS  per-key write rate (45 ms)
      10 back-to-back writes to one key in 44 ms: 0 throttled, 0 failed otherwise, last accepted write stored
PASS  batch delete (27 ms)
      50 of 50 keys listed before one batch delete, 0 after
```

MinIO reports last-modified to the second: the two writes 2000 ms apart differ by exactly 2000 ms. That is why the probe waits two seconds by default (`--settle-ms`), and why a shorter wait can fail a provider that refreshes correctly.

## Providers without a run

Each slot below is filled from `akter storage check --json` output run against a bucket in that provider, from the place that will run the store (Fly `iad` for the Cloud default). Enter the run's `checkedAt`, `cli` version, region, endpoint origin and the six probes' verdicts and `measured` values. The T5 probe supplies the first R2 and Tigris numbers (conditional-create race, compare-and-swap race, listing, per-key write rate); until its output is entered here, those rows stay "not established".

### Cloudflare R2

No run recorded. Fields to enter: date, `cli` version, account tier and jurisdiction, run location, endpoint origin, the six verdicts, `per-key write rate` throttled count.

### Tigris

No run recorded. Fields to enter: as for R2, plus whether the bucket was created in one region or globally.

### AWS S3

No run recorded. Fields to enter: as for R2, plus the region, and whether the bucket had versioning or object lock enabled (neither is a supported configuration yet).

## What a pass does not establish

- The probe does not test that an ascending listing with `max-keys` and `start-after` returns keys in order, which [ADR 0136](../decisions/0136-stores-the-bucket-is-the-store.md) lists under strongly consistent listing; the adapters rely on it and the store suites exercise it, but the provider probe does not.
- The per-key write rate is recorded, not bounded: a provider that throttles one key to one write per second passes with a nonzero throttled count.
- A pass says nothing about latency, throughput, cost, distributed or multi-region deployments, network partitions, or credentials that expire mid-run.
- The probe writes only under `check/<run>/` and removes it. On a file-system target the lease keys it wrote keep numbered tombstone files and empty directories under `check/`; a deleted lease must not be revivable by a stale etag.
