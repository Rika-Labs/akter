# Storage

Status: partially normative (0.2), owned by ADR 0127. [E8e retention evidence](../verification/e8e-retention.md) establishes mutable retention, CAS/audit atomicity, request-time admission and epoch-consistent collection. E7 establishes the shared checkpoint/index page and audit-before-answer boundaries in [its failure evidence](../verification/e7-find-operators.md). E6 implements page-backed lists, anchored history and GC within [its evidence scope](../verification/e6-pages-history.md); production-provider and 50 GB gates remain separate.

**Responsibility:** define what a store holds, how objects are written and verified, how long history is kept, and how unreachable objects are deleted.  
**Authority:** normative 0.2 target on `main`.  
**Owner role:** storage and runtime.  
**Change policy:** a layout or format change requires an ADR and a passing `akter storage check` run on every supported provider.

## The store

- A store MUST be exactly one bucket, or one prefix of a bucket given to `Store.s3({ bucket, prefix })`. Every durable byte of the store's actors MUST live in it: the log, checkpoints, pages, the persisted index, GC leases, runner leases and operator audit records. No framework component MAY require another database or service ([ADR 0136](../decisions/0136-stores-the-bucket-is-the-store.md)).
- `meta/store` MUST be created once, with `If-None-Match: *`, by the first runner of the store, and MUST record the store id, shard count, format version, initial retention and created-at. A runner whose shard configuration disagrees with it MUST refuse to start. `StoreOptions.retention` MUST seed only a new store; a different value on reopen MUST be ignored.
- `meta/retention` MUST be changed only with `If-None-Match: *` for its first write or `If-Match` for later writes. The record MUST contain effective `retentionMillis`, a positive `revision` and its operator `Audit` record. Absence MUST fall back to the initial `meta/store` value; unreadable records MUST fail closed rather than fall back. `Store.setRetention(duration, { grant, reason })` MUST require capability `retention.set` with `tenant: "*"` and no actor/command restriction, and MUST accept one through 365 days inclusive. A losing writer MUST receive `RetentionConflict`; retries MUST NOT refresh the condition.
- The store's layout is:

  ```text
  meta/store                  store descriptor, created once
  meta/retention              effective retention/revision/audit, conditional CAS
  s/<nn>/log/<offset>         segment, created once
  s/<nn>/cp/<inverted offset> checkpoint manifest, created once
  pages/<sha256>              page or manifest, plain PUT
  gc/<epoch>                  GC lease, created once
  cluster/runners/<address>   runner registration, If-Match (advisory)
  cluster/beats/<address>     runner heartbeat (advisory)
  cluster/locks/<shard>       shard lock, If-Match (advisory)
  cluster/machines/<id>       machine id claim, If-Match (advisory)
  audit/<date>/<id>           operator read audit record, created once
  check/<run>/                `akter storage check` probe objects, removed by the probe
  ```

- Shard assignments MUST NOT be stored: each runner computes them from the runner leases with `HashRing`. The lease objects stay advisory; the log fence is the only authority.

- Operator read records MUST be created once under `audit/` before answering, and a scope denial MUST write a denied record. An audit failure MUST refuse the read. E7's [operator evidence](../verification/e7-find-operators.md) establishes that boundary for the supported tenant. Shard mutation audit entries remain in the same segment as the effect. Retention mutations MUST carry their audit in the CAS record; its previous audit MUST be archived under `audit/` before replacement, and `Store.audits` MUST include the current embedded audit. Archive failure MUST prevent the update. [E8e evidence](../verification/e8e-retention.md) owns this store-scoped boundary.

- `Store.fileSystem(dir)` MUST implement the same protocol on one host (`O_EXCL` create, atomic rename). `Store.memory()` is for tests and MUST NOT be presented as durable.

## Supported providers

A provider is supported only while `akter storage check` passes on it: atomic conditional create under concurrency, atomic `If-Match` compare-and-swap, strongly consistent ordered listing, and last-modified refreshed by a plain `PUT`. The [support matrix](../verification/store-providers.md) MUST name each provider with the date and version of its passing run. Simulator, filesystem and MinIO results MUST NOT be presented as results for another provider.

`akter storage check` MUST open no store in the target: it writes only under `check/<run>/`, removes what it wrote, and creates neither `meta/store` nor any `audit/` record. It MUST exit non-zero when any probe fails, and it MUST NOT print credentials.

## Segments and checkpoints

- A segment MUST be created with `If-None-Match: *` and never overwritten. It holds `{ format, writer, open, build, entries }`.
- A checkpoint manifest MUST be created with `If-None-Match: *` at the inverted offset it covers, only after every page it references is written. It MUST cover the shard's actor manifest pointers, timer wheel and `nextDue`, pending cross-shard sends, job table, deduplication state, open connections and index pages.
- Independent page graphs MAY upload concurrently with a finite bound. Capture order and the captured durable prefix MUST NOT depend on completion order, and all uploads MUST finish before their shard root or checkpoint reference is published. The publication exclusion MUST cover those uploads through the durable reference.
- A checkpoint page MAY hold both durable state and its index rows; its hash MUST appear in both manifest page lists. Index rows MUST change only with the durable transition, and recovery MUST reproject decoded state so schema evolution cannot retain stale field values.
- When a checkpoint's pages are missing or corrupt, recovery MAY start from an older checkpoint whose following segments are all retained, and MUST report the damaged one; otherwise it MUST refuse the shard. It MUST NOT fall back to default state ([recovery](09-recovery.md)).

## Pages

- A page MUST be keyed by the SHA-256 of its bytes and MUST be verified against its key on every read; a mismatch MUST be the `PageCorrupt` defect and MUST NOT yield default or partial state.
- Pages and manifests MUST be written with a plain `PUT`. A `412` or `429` on a content key MUST be resolved with `HEAD`: an existing object of the expected length whose last-modified time is no older than `T_trim` before the write began is success; otherwise the write MUST be retried or fail, because a page write is also the timestamp refresh that keeps the page from GC while a publication references it.
- An interrupted page or manifest upload MUST leave no reference to it: references are written only after the referenced objects exist.
- Encoding at rest is `SchemaBinary` under the store's format version.

## State and lists

- An actor manifest MUST hold the encoded state without lists, at most 256 KiB, and the root of each list's page tree.
- `Actor.list` items MUST live in page trees ordered by `by` then `key`, with no size limit. A snapshot MUST write only the pages that changed.
- A nonresident page MUST stop a synchronous action with the internal `PageMiss` signal. Its draft and all staged effects MUST be discarded; the resolver loads the missing hashes and reruns from the same command id and admission time. An absent bucket object remains `PageCorrupt`, never an empty list.
- The clean-page cache MUST be byte-bounded. An invocation MAY hold a larger temporary working set until its reruns finish, so eviction MUST NOT make a wide range retry forever. An owner MUST revalidate its lease after a page load before it answers or stages work.

## History

- Segments and checkpoints MUST be kept for the store's effective retention period (default 7 days; Akter Cloud sets 7 days on Free and 30 days on paid plans). History, forks and log inspection MUST read the effective value at request time. Explicit expired positions MUST be refused; catalogue reads from zero MUST omit expired segments. Recovery and fork reconstruction MAY read older boundary bytes without authorizing expired positions.
- History MUST expose the newest checkpoint at or before the first in-window segment's starting position as an anchor, together with the complete chain after it, including older boundary segments. A whole-segment checkpoint at the first segment's own offset is after its first entry, so the preceding checkpoint is required for entry-index positions within it. Requested fork positions MUST remain inside retention.
- Trim MUST delete only segments older than retention and covered by a checkpoint older than `T_trim` (10 minutes), and MUST stop at the anchor offset. Other checkpoints older than retention MAY be deleted except each shard's newest checkpoint. The old anchor and chain MAY be released when the boundary advances. Segments are the history archive.

## Garbage collection

- Roots MUST be every checkpoint within retention, each shard's newest checkpoint and history anchor, and the fork/replay images referenced by the complete chain after the anchor. An image in the uncovered recovery tail MUST remain a root even after its retention expires. GC MUST NOT delete an object reachable from a root (I7).
- A collector MUST hold the newest `gc/<epoch>` key, created with `If-None-Match: *`, and MUST confirm before every delete batch that no newer key exists, verifying under the same `T_valid` rule as a shard owner. Two collectors MUST NOT delete concurrently.
- A collector MUST read effective retention once after claiming its marking epoch and MUST use that value for the whole pass, including subsequent deletion subepochs. A concurrent change MUST apply on the next pass. Widening MUST preserve still-stored history in the larger window, but MUST NOT claim to restore already-trimmed history. Narrowing MUST keep the new anchor and its complete chain. A separate shard trim request MUST read and capture effective retention once.
- A checkpoint or fork publisher MUST claim a `publishing` epoch before its first page write, and MUST confirm that epoch is still the newest, within `T_valid`, after its page writes are acknowledged and before it writes the reference; the reference MUST NOT be sent unless that confirmation succeeded. The reference MUST name only pages written in this upload under the page rules below, or pages reachable from a checkpoint GC keeps as a root for the whole publication. A reference that lands later than the grace period less `T_trim` after the upload began MAY name a deleted page. Concurrent publishers of one process MAY share one `publishing` epoch; each member confirms for itself, and a member MAY join only within `T_valid` of the claim and while no member's reference has ended without a known outcome. A collector MUST claim a `deleting` epoch before an unconditional DELETE. `marking` epochs MAY expire at their `expiresAt`; a `publishing` epoch MAY be taken over 60 seconds after its claim (its `expiresAt` records the claim time). A `deleting` epoch MUST NOT expire: an unknown deleting outcome MUST block subsequent collection and publication. Successful completion of every member creates the next immutable `idle` epoch. A member that stopped before sending its reference, or whose reference stopped with a confirmed `StaleEpoch`, MAY also let the epoch advance to `idle`; after a reference with an unknown outcome, defect or interruption, or a failed confirmation, it MUST NOT, and the epoch blocks until it expires ([ADR 0139](../decisions/0139-expiring-fenced-shared-publication.md)). Timestamp checks alone MUST NOT be treated as a fence against PUT/DELETE races.
- GC MUST delete only unmarked objects whose last-modified time is older than the grace period (default 24 hours, and more than twice the longest checkpoint interval plus `T_trim`).
- A snapshot MUST either write a page again with plain `PUT` or reference only pages reachable from the actor's current durable manifest.
- History and pages MUST be expired by GC, not by provider lifecycle rules.

## Erasure

Deleting an actor (an audited operator operation) MUST make its pages unreachable once the last retained checkpoint referencing it ages out; GC removes them after the grace period. The documentation of any deletion promise MUST state that delay. Tenant-wide erasure is not offered in 0.2.0.

## Isolation

- A runner MUST hold credentials for its own store only (I8a). Expired temporary credentials MUST be refreshed and the operation retried, not reported as `ActorUnavailable` until refresh fails.
- Object keys carry no tenant; tenant isolation inside a store is the engine's ([security](10-security.md)). No client API reads object keys.

## Packaging

The S3 adapter MUST live in `@rikalabs/akter/server`. A runtime that composes only `Store.fileSystem` or `Store.memory` MUST bundle no AWS or Smithy module, including builds without code splitting.

## Verification

I6 (a snapshot plus later entries equals the live state), I7, I8a; F9 (crash during checkpoint upload; between pages and manifest), F10, F20–F22, F21′ (a snapshot that deduplicates against a page older than the grace period), F25 (expired credential on a resumed runner).
