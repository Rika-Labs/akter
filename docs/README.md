# Akter documentation

This documentation describes Akter 0.2. The normative runtime target is in [contracts](contracts/README.md), design rationale is in [decisions](decisions/README.md), and executable evidence is in [verification](verification/README.md). A proposal is not a provider-support claim.

## Public distribution

- `@rikalabs/akter`: `Actor`, caller schemas, errors, contracts, and the Effect client.
- `@rikalabs/akter/server`: `Akter.serve`, `Store.s3`, `Store.fileSystem`, `Store.memory`, and `App`.
- `@rikalabs/akter/testing`: seeded `Simulation`.

The framework has one client model: `X.client(id)` and static `X.find(...)`, both Effect APIs. The server exposes one RPC group at `/rpc`: JSON over WebSocket and NDJSON over HTTP POST.

## Storage and support

A durable deployment uses one bucket per environment. The bucket is the command log, fence, checkpoints, pages, indexes, runner bookkeeping, and operator audit records. `Store.fileSystem(dir)` is the local `akter dev` adapter; `Store.memory()` is for tests only. `akter storage check` probes a bucket or directory without opening a store.

MinIO and filesystem results are local evidence only. R2, Tigris, and other providers remain unestablished until the provider-specific check passes and the support matrix records the run.

## Authority order

When pages disagree, use accepted decisions first, then the owning contract, then architecture and API pages. Dated verification pages preserve what was observed at the time and are not silently rewritten as current guarantees.
