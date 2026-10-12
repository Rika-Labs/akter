# ADR 0136: Stores: the bucket is the log, the pages, the index and the runner leases

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** decide what a store is made of, which backends are supported and how support is proven, how Akter runs in development, self-hosted and in Akter Cloud, and how stores are isolated.

**Owner role:** storage, runtime and operations.

## Context

0.1 supports Postgres and file-backed PGlite as its only backends ([ADR 0112](0112-postgres-and-pglite-only.md)), claims PGlite as an embedded production backend ([ADR 0035](0035-pglite-embedded-production-backend.md)), and its hosted contract has customers bring their own Postgres while Akter Cloud bills compute only ([ADR 0113](0113-customer-postgres-cloud-contract.md)). The first 0.2 plan kept a Postgres log in shared regional clusters (D3, D4, D11). D18 replaced that: an S3-compatible bucket is the framework's only storage dependency. D1 gives each Cloud environment incarnation its own bucket, D2 picks Cloudflare R2 with Tigris as the fallback (D21), and the T5 probe gates the decision on R2's conditional-create atomicity and PUT latency from Fly `iad`.

"S3-compatible" alone does not define support: providers differ in whether concurrent create-once writes are atomic, whether listing is strongly consistent, and how fast one key can be written.

## Decision

### 1. One `Store` service

A store is one bucket (or one prefix of a bucket) holding everything durable:

```text
meta/store                  store descriptor, created once
s/<nn>/log/<offset>         segments
s/<nn>/cp/<inverted offset> checkpoint manifests
pages/<sha256>              state, list, manifest and index pages
gc/<epoch>                  GC lease
cluster/runners/<address>   runner registration (advisory)
cluster/beats/<address>     runner heartbeat (advisory)
cluster/locks/<shard>       shard lock (advisory)
cluster/machines/<id>       machine id claim (advisory)
audit/<date>/<id>           operator read audit records
```

Shard assignment is not stored: each runner computes it from the runner leases with `HashRing`.

The `Store` service provides the log ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md)), pages ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)), the persisted index ([ADR 0131](0131-find-over-owner-held-index.md)) and the runner leases ([ADR 0135](0135-effect-primitive-inventory.md)). Its implementations:

| Layer                                                    | Used by                                 | Notes                                                                                   |
| -------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `Store.s3({ bucket, prefix?, endpoint?, credentials? })` | production, self-hosted and Akter Cloud | `credentials` may be a refreshing source; `prefix` lets several stores share one bucket |
| `Store.fileSystem(dir)`                                  | `akter dev` and local tests             | `O_EXCL` create, `rename`, one directory per shard; single host                         |
| `Store.memory()`                                         | `Simulation` and unit tests             | not durable                                                                             |

The S3 adapter uses the AWS SDK as a signer only, without server-side-encryption options, and lives in `@rikalabs/akter/server`. A runtime that composes only `Store.fileSystem` or `Store.memory` bundles no AWS or Smithy code, including builds without code splitting (the rule [ADR 0120](0120-s3-adapter-entry.md) established).

### 2. Supported means "passes `akter storage check`"

`akter storage check <bucket>` runs the conformance probe and prints a pass or the failing property:

1. **Conditional create is atomic:** concurrent `PUT` with `If-None-Match: *` to one key from many writers, over many rounds, yields exactly one success per round.
2. **Compare-and-swap is atomic:** concurrent `PUT` with `If-Match` on one ETag yields one success.
3. **Listing is strongly consistent:** a key is listed immediately after its create returns, and an ascending list with `max-keys` and `start-after` returns keys in order.
4. **Overwrite refreshes last-modified** for a plain `PUT` of identical bytes.
5. **Per-key write rate** is measured and reported (R2 allows one write per second per key; the key layout never needs more).
6. **Batch delete** works.

A store that fails any of 1–4 is unsupported. The supported-provider list in the support matrix names each provider and the date and version of its passing run; MinIO runs in CI and the chosen Cloud provider runs nightly. Simulator and MinIO passes are never relabeled as provider passes.

### 3. Store lifecycle

- The first runner of a new store creates `meta/store` with `If-None-Match: *` (store id, shard count, format version, retention, created-at). A runner whose configuration disagrees with an existing `meta/store` refuses to start. There are no schema migrations: the format version changes only through a new ADR.
- **Development:** `akter dev` uses `Store.fileSystem` with no flags and no services.
- **Self-hosted:** one container image plus a bucket: `AKTER_BUCKET`, an endpoint and credentials. The compose reference runs MinIO. Multi-runner self-hosting coordinates through the bucket.
- **Akter Cloud:** one bucket per environment incarnation in a Cloudflare account dedicated to customer stores (D1, D12), created lazily at the first deployment, delivered to runners as temporary bucket-scoped credentials refreshed through the edge, retired 30 days after the environment is deleted (D13). Preview and pull-request stage stores live in a third Cloudflare account, so a preview stage token can never reach a production store (D26). The hosted runtime composes these public layers privately; there is no public `AkterCloud.layer`. Cloud ADRs own the lifecycle.

### 4. Isolation

- **Between stores (I8a):** a runner holds credentials for its own store's bucket or prefix only. No framework API names another store.
- **Between tenants in a store (I8b):** the engine scopes every action, read, send, `find` and fork to the caller's tenant. Pages are shared by hash within a store; knowing a page key grants nothing, because no client API reads keys ([contract 10](../contracts/10-security.md)).
- Encryption at rest is the provider's default; Akter adds no per-tenant envelope encryption in 0.2.0.

### 5. Regions

A store lives in one region. An application that needs another region runs another environment with its own store. The tenant directory and tenant home regions are removed.

## Supersedes and amends

- Supersedes [ADR 0035](0035-pglite-embedded-production-backend.md) — scope: PGlite as an embedded production backend.
- Supersedes [ADR 0113](0113-customer-postgres-cloud-contract.md) — scope: in full; customer Postgres and compute-only billing end.
- Supersedes [ADR 0112](0112-postgres-and-pglite-only.md) — scope: the sentence making Postgres and PGlite the only backends; the Neki removal and its historical supersessions stand.
- Amends [ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md): one region per environment; the tenant directory is removed.
- Amends [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) §7: operator-assigned tenant home regions end.
- Amends [ADR 0051](0051-row-level-security.md): store isolation is bucket credentials.
- Amends [ADR 0069](0069-node-runtime.md): `Store.s3` and `Store.fileSystem` work under Node and Bun.
- Amends [ADR 0074](0074-open-source-control-plane.md) and [ADR 0075](0075-deployment-and-runner-orchestration.md): hosted storage decisions move to Cloud ADRs; there is no database probe.
- Amends [ADR 0109](0109-self-host-recipe.md): the self-host recipe is one bucket.
- Amends [ADR 0120](0120-s3-adapter-entry.md): the no-AWS-in-other-runtimes rule carries onto `@rikalabs/akter/server`.

## Alternatives

- **Postgres log plus bucket** (D3, D4). Superseded by D18.
- **Accept any "S3-compatible" provider.** Rejected: the design rests on conditional-create atomicity, which compatibility claims do not prove.
- **PGlite for development.** Rejected: a second backend in development would diverge from production; the filesystem adapter runs the same protocol.
- **A public `AkterCloud.layer`.** Rejected: the framework contains no Cloud-only code.

## Consequences

- Nothing to install for development; self-hosting is a bucket; Cloud runs no database for customer stores.
- Per-action latency is the provider's PUT latency (D20); providers are compared by the probe, not by marketing.
- Akter Cloud takes custody of end-user data (D17 limits the preview to no production data).

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E0        | T5 probe on R2 and Tigris from Fly `iad`                                                                                                                                                                                                        |
| E2        | `akter storage check` passes on MinIO and fails on a deliberately non-atomic fake; the same protocol suites pass on `Store.fileSystem`, MinIO and the provider; packaging test that a filesystem-only bundle has no AWS modules on Node and Bun |
| E4        | I8a (a runner with another store's credentials can read and write nothing of this store) and I8b suites                                                                                                                                         |

## Revisit when

- The probe fails on R2 and Tigris (D21 names the fallback; the engine does not change).
- A provider passes the probe but measured latency or cost rules it out.
- A customer needs one environment across regions.
