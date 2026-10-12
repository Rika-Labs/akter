# Store protocol evidence

**Responsibility:** bind the 0.2 `Store` service's bucket-protocol claims to executed scenarios.  
**Authority:** verification evidence.  
**Owner role:** runtime/storage reliability.  
**Change policy:** a new store transition or bucket requirement needs a conformance scenario that names the wrong implementation it rejects.

`Store` is exported from `@rikalabs/akter/server`; its source is `packages/akter/src/store/`. One bucket holds each shard's log segments (`s/<shard>/log/<offset>`), checkpoint manifests (`s/<shard>/cp/<inverted offset>`), content-addressed pages (`pages/<sha256>`), the identity record `meta/store` and lease objects under `cluster/` and `gc/`. A segment is created once at `head + 1`, and that create-once write is the fence. No clock sits in the commit path. The adapters are `Store.s3` (S3-compatible, through `@aws-sdk/client-s3`), `Store.fileSystem` (one local directory) and `Store.memory`. The 0.1 runtime does not use the store yet, so nothing here is a claim about 0.1 behavior.

## Suite and backends

[`conformance/store.ts`](../../tooling/conformance/src/conformance/store.ts) runs the same thirteen scenarios against every backend. The owners in a scenario are separate store instances, each with its own client and fault plan, over one shared location. The test clock drives `validFor` (10 s) and `trimAfter` (10 min), so the timing rules are tested at their boundaries, not by sleeping.

| Backend         | Test file                                             | Bun                                                    | Node              |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| Process memory  | `packages/akter/src/store/memory.test.ts`             | `packages/akter` `test`                                | `test:node:units` |
| Local directory | `packages/akter/src/store/file-system.test.ts`        | `packages/akter` `test`                                | `test:node:units` |
| S3-compatible   | `packages/akter/src/store/s3.test.ts` (`TEST_S3_URL`) | Postgres integration project (`--project=integration`) | `test:node:units` |

CI starts MinIO RELEASE.2026-09-22 (`cgr.dev/chainguard/minio`, pinned by digest, the same image as the cold-storage drill) in the shards that run those commands and sets `TEST_S3_URL`. Locally, `docker compose up -d minio` starts the same server, and the URL is in `compose.yaml`. Each S3 scenario writes under a fresh random key prefix in one bucket.

Faults come from `Faults.plan()`, which wraps a bucket between the store and its adapter. `Delay` and `Hold` postpone a matching call. `Unavailable` fails it before it reaches the bucket. `LoseResponse` performs it and then fails, the way a write lands but its response is lost. Faults model what a client can observe; they do not change how the provider behaves.

| Scenario                                                                               | Wrong implementation it rejects                                                    |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A stale owner's append fails after another owner opens                                 | A fence kept only in process memory, or a plain `PUT` for segments                 |
| Six concurrent opens get distinct epochs; only the newest lease appends                | An open without create-once, which lets two owners share an epoch                  |
| A lost-response append is recognized as the owner's own and stored once                | Retrying at the next offset, or failing a write that committed                     |
| A lost-response append that another owner overtook fails `StaleEpoch`                  | Treating every `412` after a retry as the owner's own write                        |
| A failed manifest write leaves the previous checkpoint authoritative                   | Recovering from pages that no durable manifest names                               |
| Recovery returns every acknowledged batch once, in order, from the newest checkpoint   | Reading the oldest checkpoint, duplicating lost-response batches, reordering       |
| Trim deletes only segments covered by a checkpoint known for `trimAfter`               | Trimming segments no checkpoint covers, or trimming as soon as a checkpoint exists |
| An owner idle past `validFor` whose next key was trimmed fails before it writes        | Appending without re-checking after `validFor`, which would recreate a trimmed key |
| An owner re-checks once after `validFor` and not within it                             | Never re-checking, or checking on every append                                     |
| Pages are stored once per content hash and verified on load                            | Keys not derived from content, or loads that trust stored bytes                    |
| Concurrent creators all read one `meta/store`                                          | A last-writer-wins identity record                                                 |
| Runner storage splits shards, moves a dead runner's shards and drops a paused runner's | Locks taken while their owner's heartbeat still moves                              |
| The backend passes `Store.check`, which removes everything it wrote                    | A backend whose conditional writes, compare-and-swap or listings are not atomic    |

`Store.check` is the probe that defines a supported bucket. It races concurrent create-once writers and concurrent compare-and-swap writers, checks that listings show completed creates and deletes, measures back-to-back writes to one key, and runs one batch delete. Applications can run it against their own bucket before they rely on it.

## Adapter-specific evidence

The S3 adapter turns off the SDK's own retries, so every repeated write goes through the store's retry schedule, which reads a create-once write back to recognize its own. `s3.test.ts` also runs a local stand-in server that answers a conditional create with `412` and then drops the next request on that kept-alive connection without responding. MinIO RELEASE.2025-09-07 does this; RELEASE.2026-09-22 keeps the connection open. The test shows that the adapter sends a dropped read again exactly once, on a fresh connection, and never sends a write again. Removing the read resend, or resending writes too, fails the test.

The file-system adapter writes each object to a temporary file, fsyncs it, then links it into place for create-once or renames it for a plain put. A lease is a directory of numbered versions, and its etag is the version number. These guarantees hold on one host's local file system only.

## Not established

- No evidence for Cloudflare R2, Tigris or AWS S3. The adapter maps AWS's `409` for a concurrent conditional write to `StoreUnavailable` from documentation, not from a test.
- MinIO runs as one node in one container. Distributed erasure sets, network partitions, real clock behavior and provider throttling are not exercised. The per-key write-rate probe records throttling but sets no bound.
- A crash between page writes and the manifest is simulated by failing the manifest write, not by killing a process. The 30-second request timeout that bounds how late a paused owner's write can land is configured but not measured.
- With MinIO RELEASE.2025-09-07, many concurrent `412` responses can leave more than one dropped connection in the pool. A resent read can then meet a second one and surface `StoreUnavailable` to the store's retry schedule. This was seen once locally, in `Store.check`'s race probe.
- No throughput, latency or cost measurement.
