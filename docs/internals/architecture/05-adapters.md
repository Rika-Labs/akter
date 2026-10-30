# Store and runtime adapters

`Store` owns log, pages, descriptor, index persistence, cluster bookkeeping, and audit storage through one bucket protocol. There is no framework SQL adapter.

| Adapter                         | Intended use                         | Boundary                                                                             |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `Store.s3({ bucket, prefix? })` | Durable store                        | Provider must pass conditional-create, CAS, ordered-list, and overwrite-mtime probes |
| `Store.fileSystem(dir)`         | Local development and one-host tests | Local filesystem semantics; not distributed object-provider evidence                 |
| `Store.memory()`                | Unit tests and seeded simulator      | No restart durability                                                                |

The S3 adapter is exported from `@rikalabs/akter/server`. The root and client bundles load no AWS SDK, store, or Cluster module. A server build that does not use `Store.s3` tree-shakes the AWS/Smithy modules.

Effect Cluster remains behind Akter's routing layer for membership, assignment, and socket routing. It does not persist application messages through SQL, supply write authority, or run jobs through `ClusterWorkflowEngine`. Jobs use the shard-journaled workflow engine.

Run `akter storage check` against the actual provider before calling it supported. [Provider evidence](../verification/store-providers.md) records dates and versions; MinIO results cannot certify R2, Tigris, or AWS S3.
