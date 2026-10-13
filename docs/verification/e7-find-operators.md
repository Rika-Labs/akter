# E7 find, operators, local development and telemetry

**Status:** local E7 evidence on `rewrite/e7-find-operators`; no provider or hosted support claim.

## Index and `find`

The owner-held index stores every durable top-level scalar state field. String values use the first 64 UTF-8 bytes represented in the index; lists, arrays, records and nested structs are not indexed. A durable action updates the row only after its segment append; a discarded or interrupted action cannot publish an index row. Checkpoints carry the index page and recovery rebuilds it before applying the retained tail. `X.find` returns ids only, runs actor `access` once with kind `find`, wakes every shard, and merges owner rows by one order field and a stable encoded-id tie-break.

| Wrong implementation rejected                                 | Evidence                                                                                                                                                                                                      | Command                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Speculative state updates a visible index                     | `durable owner index` holds an append in flight and proves old rows remain while the new row is absent                                                                                                        | `bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/execution/indexes.test.ts`                                         |
| Crash/replay leaves a stale or missing entry                  | The same test crashes before/after append, reopens from checkpoint plus tail, and compares ids and range results                                                                                              | same                                                                                                                                |
| A move or checkpoint keeps only one scalar field consistent   | Seeds 2301–2332 each perform 20 changes over four shards, with crashes, checkpoints and a split-owner move; every owner row is compared with independently projected durable scalar values after every change | same                                                                                                                                |
| A split owner scans local memory or applies a per-shard limit | Real mTLS routing scatter-gathers owner rows, applies one global limit and stable ties, and counts one `find` access check                                                                                    | `bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/runtime/sharding.test.ts`                                          |
| A rejected cross-shard send is omitted from inspection        | The index/operator suite records the durable rejection tag without exposing its payload                                                                                                                       | `bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/execution/indexes.test.ts`                                         |
| Filesystem or memory behavior hides provider assumptions      | Index/operator conformance runs under both adapters; S3 wiring registers it for the MinIO suite                                                                                                               | `bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/store/memory.test.ts packages/akter/src/store/file-system.test.ts` |

The MinIO suite is local S3-compatible evidence only. `R2`, `Tigris`, AWS S3 and hosted multi-tenant behavior need their own provider/Cloud evidence.

## Audited operator surface

`POST /operator` authenticates only `OperatorAuth` grants, never application callers or `System`. Reads (`inspect`, `log`, `snapshot`, `outcomes`, `audit`) create an `audit/<date>/<id>` object before answering and fail closed if that write fails; scope denials are audited. Replay writes its `Replayed` image and `Audit` entry in one durable segment and checkpoints only after the pages exist. Audit and telemetry exclude payload values. Inspection returns outcome tags and sent-action rejections, not their values; independently granted log/snapshot reads may return authorized data values.

CLI forms are `inspect actor`, `inspect shard`, `log tail`, `log export`, `snapshot`, `replay`, and `dev`. The operator CLI suite exercises allowed grants, wrong tenant grants, missing tokens, explicit `--token-env`, application-only credentials, build-matched replay and `--current` opt-in over a real HTTP server. `akter dev` loads `App.make`, uses the filesystem store, serves `/rpc` and `/metrics`, and drains/reopens state in the test.

## DevTools and telemetry

`Telemetry.layer` wires Effect OTLP traces/metrics and optional Effect DevTools; `Telemetry.prometheus` formats the stable metric registry. E7 telemetry evidence runs a real local OTLP collector and WebSocket DevTools endpoint, checks stable names/labels, and verifies credential/payload redaction in exporter data and failed span status. No OTLP logs exporter or production collector guarantee is claimed.

## Exact commands

- `bun run --cwd packages/akter typecheck`
- `bun run --cwd packages/akter lint`
- `bun run --cwd apps/cli typecheck`
- `bun run --cwd apps/cli lint`
- `bun run --cwd tooling/conformance typecheck`
- `bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/execution/indexes.test.ts packages/akter/src/runtime/sharding.test.ts packages/akter/src/runtime/telemetry/observability.test.ts apps/cli/src/commands/operator.test.ts apps/cli/src/commands/dev.test.ts`

## Full local checks

On Dallen's Mac (macOS arm64, Bun 1.4.2, Node v26.7.0):

- `bun install --frozen-lockfile`: passed without a lockfile change.
- `bun run check`: passed all 45 Turbo tasks, including lint, format, structure, types, tests, builds and `pack:check`.
- `bun run --cwd packages/akter test`: 31 files / 222 tests passed.
- `node node_modules/vitest/vitest.mjs run packages/akter/src --exclude packages/akter/src/store/s3.test.ts --exclude packages/akter/src/runtime/cluster-process.test.ts`: the same complete non-S3 package suite passed on Node.
- `bun run --cwd apps/cli test`: 13 files / 65 tests passed.
- `bun run test:node:units`: passed.
- `bun run pack:smoke` and `SMOKE_RUNTIME=node bun run pack:smoke`: passed clean installs, public entry typechecks, HTTP/WebSocket serving and CLI checks.
- `TEST_S3_URL=<ephemeral MinIO test URL> bun run test:integration`: passed on retry, with 45 framework tests on each of Bun and Node and three CLI storage-check tests. The first parallel run hit the CLI's unchanged 15-second timeout and aborted the framework run; both packages then passed separately before the root retry passed. No assertions, timeout settings or production behavior were changed to obtain a pass.
- The E7-owned ephemeral MinIO container was removed after testing. No provider-specific behavior is established by this run.

The inherited E3 T6 test measures rather than asserts the five-second target. In the successful standalone run, clean handoff was 15,082 ms on Bun / 15,092 ms on Node, crash takeover was 30,643 ms / 31,422 ms, and replay of 10,000 action entries was 176 ms / 218 ms. Clean/crash target flags remained false; the replay target passed. A green test run does not promote the unmet timing targets.
