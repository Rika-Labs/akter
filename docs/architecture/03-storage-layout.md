# Store layout

The store is a bucket, not a database plus an archive. `Store.s3({ bucket, prefix })` confines all keys to that bucket or prefix. `Store.fileSystem(dir)` implements the protocol locally; `Store.memory()` is non-durable.

```text
meta/store                  create-once descriptor
s/<nn>/log/<offset>         create-once segment chain
s/<nn>/cp/<inverted offset> create-once checkpoint manifests
pages/<sha256>              content-addressed pages and manifests
gc/<epoch>                  create-once collector fence
cluster/runners/<address>   advisory registration
cluster/beats/<address>     advisory heartbeat
cluster/locks/<shard>       advisory lock
cluster/machines/<id>       advisory machine claim
audit/<date>/<id>           create-once operator read audits
check/<run>/                temporary protocol probe objects
```

Segments contain format, writer, open epoch, build, and entries. Checkpoints reference actor manifests, list and index roots, deduplication state, pending sends, timers, jobs, and connection obligations. Pages are written before any manifest referencing them. SHA-256 is checked on every page read. Stored encoding is `SchemaBinary`; `/rpc` uses JSON schemas.

An actor's non-list state is at most 256 KiB; list items live in ordered page trees. Default history retention is seven days. Trim must retain an old-enough covering checkpoint and every segment needed to recover; provider lifecycle rules must not delete active history or pages. GC roots include all retained checkpoints and each shard's newest checkpoint.

The [storage contract](../contracts/06-storage.md) owns the full E2/E6 target, including interrupted uploads, grace periods, collector fencing, forks, and erasure delay. Check its section status before treating a layout description as implemented evidence.
