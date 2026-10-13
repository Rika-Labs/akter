# E3 cluster evidence

**Responsibility:** bind assignment, peer routing, durable sends, timers/cron and graceful handoff to executable failure evidence.
**Authority:** E3 verification for the `default` tenant; measured results do not establish an untested provider, multi-tenant addresses or Cloud orchestration.
**Owner role:** runtime and reliability.
**Change policy:** preserve each distinct failure boundary and name the plausible wrong implementation it rejects.

## Boundaries

`runtime/sharding.ts` adapts public Effect Cluster APIs to the engine. Bucket-backed `RunnerStorage.makeEncoded` observes heartbeat ETags; Cluster computes assignments with `HashRing`. Only a new acquisition invokes `engine.assign`, while lost locks unassign the shard. Orderly release checkpoints and appends `Released` before advisory release. The create-once log chain remains the only write authority.

Peer shard entities carry actions and reads over the kept TLS 1.3 transport with the authenticated caller in an envelope header. Client command ids and send stream sequences remain unchanged by retries. A peer effect request has a ten-second default bound; an owner move ends a live read so the client reconnects from a fresh full frame. Engine publication still follows the durable prefix.

The seeded simulator uses one root fiber per run, the seeded scheduler and TestClock over a fault-injected bucket. It now supports independent shard assignments and routes sends to each shard's current owner. It models assignment explicitly; it is **not** real socket/Cluster membership evidence. Real mTLS tests and several MinIO runner processes establish those boundaries separately. No R2 or Tigris result is inferred from MinIO.

## Failure mapping

| Failure  | Executable scenario                                                                                                                                                                                                      | Wrong implementation rejected                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13 / I5 | `testing/cluster.test.ts`: two shards on different runners, changing both owners under crashes, partitions, lost responses and slow writes; `runtime/sharding.test.ts`: a send through real mTLS while its sender drains | Delivery stays local, a moved sender loses its outbox, a retry gets a new sequence, or a receiver watermark expires and applies a send twice                   |
| F14      | Split-shard timer matrix; the focused expired-lease verification outage and seed `1007681566` interruption case                                                                                                          | A due timer remains armed forever after temporary unavailability, or interruption between marking `opening` and forking recovery strands it                    |
| F15      | `contract/cron.test.ts`, `execution/cron.test.ts` and the existing schedule/ownership tests                                                                                                                              | Spring gaps drift to the same minute after the gap, autumn folds fire twice, half-hour gaps are treated as one-hour gaps, or downtime replays missed intervals |
| F16      | `runtime/sharding.test.ts`: a non-owner gateway returns the owner's durable outcome, preserves caller access, rejects another caller's replay, and bounds a held append before same-id retry                             | The gateway executes locally, replaces the caller with its own principal, waits forever, exposes undurable state, or mints a new id on retry                   |
| F24      | Orderly lock-release adapter and MinIO release-barrier process scenario                                                                                                                                                  | A new release opens before the live old release checkpoints and appends `Released`, or a failed release silently frees its advisory lock                       |
| F27      | Simulator drain, timer due with no assigned runner, restart on another owner and another crash                                                                                                                           | The checkpoint/report loses `nextDue`, the overdue timer is dropped or fires twice, or its original principal is lost                                          |

Promotion of the release-to-store peering boundary still requires the captain's explicit confirmation of [ADR 0126's amendment](../decisions/0126-shard-ownership-on-the-bucket-log.md#e3-amendment-assignment-peering-and-the-release-barrier).

## Real MinIO processes and jobs

`runtime/cluster-process.test.ts` runs independent Bun or Node processes with real bucket operations and the real mTLS transport. Its seven scenarios cover the following failure boundaries and the T6 measurement:

- F13 kills the sender after a durable send during a receiver partition, reopens on another runner and restarts the receiver; exactly one receiver action and one delivery acknowledgement remain.
- F14/F27 kills a timer owner, preserves the original due instant and fires each timer once after takeover. It then stops every process with another pending timer, retains its `nextDue` in the drain report and fires once when a later process reopens the store.
- F15 restarts owners over New York's spring gap and autumn fold. Only wall instants are injected; the bucket, transport and processes remain real. The spring tick fires at the first instant after the gap and the autumn tick only at its first occurrence.
- F16 drops a durable reply and partitions a peer. Same-id retry receives the original outcome from its owner, while the partition returns a bounded retryable failure.
- F24 stops the old release before drain, verifies the new release is still standby, then uses SIGTERM. Readiness falls before checkpointing, the host emits its drain report, and new-build ownership follows durable `Released` entries.
- F17′/F27 jobs kills the job owner after a remote actor effect but before reply journaling. Replay preserves the outcome, a durable workflow deadline survives another drain and a no-runner interval, and completion retires both call streams. A second job runs across two live peers and cannot retire locally only. The split-owner simulator separately moves both job and receiver shards and checks exactly two actor calls, one completion and two receiver retirements.

The T6 scenario writes 10,000 actions, measures clean handoff and crash takeover under unchanged defaults, and measures replay of the checkpoint tail. Neither move meets the five-second target under those defaults; tail replay meets one second. Exact local timings, host and runtime are preserved below and in the captain report rather than represented as provider performance.

Receiver retirement first crosses the engine's recovered-image and lease-validity read barrier. It never treats an unopened shard as a receiver stream. The first full MinIO run exposed an extra retirement on an unopened empty shard; the engine barrier fixes that cause without weakening the exact retirement assertions.

Final local MinIO measurements on `dallens-mbp.lan`, macOS arm64, with 30-second lock expiration and 15-second assignment refresh:

| Runtime     |  10k write |  Clean move | Crash takeover | Tail replay | Gates                            |
| ----------- | ---------: | ----------: | -------------: | ----------: | -------------------------------- |
| Bun 1.4.2   | 1,216.9 ms | 15,137.3 ms |    30,649.8 ms |    142.8 ms | move targets fail; replay passes |
| Node 26.7.0 | 1,228.1 ms | 15,096.5 ms |    31,721.9 ms |    172.9 ms | move targets fail; replay passes |

The suite records failed timing gates without asserting a fabricated five-second pass. All 42 integration scenarios passed on each runtime: 35 Store/engine/jobs cases and seven Cluster process cases. Those protocol passes do not waive T6.

## Reproduction

From the repository root:

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/runtime/sharding.test.ts packages/akter/src/testing/cluster.test.ts packages/akter/src/contract/cron.test.ts packages/akter/src/execution/cron.test.ts packages/akter/src/execution/timer-wheel.test.ts
node node_modules/vitest/vitest.mjs run packages/akter/src/runtime/sharding.test.ts packages/akter/src/testing/cluster.test.ts packages/akter/src/contract/cron.test.ts packages/akter/src/execution/cron.test.ts packages/akter/src/execution/timer-wheel.test.ts
bun run --cwd packages/akter test
bun run test:node:units
TEST_S3_URL="$TEST_S3_URL" bun run --cwd packages/akter test:integration
bun run pack:smoke
SMOKE_RUNTIME=node bun run pack:smoke
```

The new split-owner suite runs 1,000 faulted seeds and 50 exact byte-replay seeds. The original simulator retains its 1,000 crash seeds, 200 moving seeds and 50 stationary/20 moving exact replays. No old behavioral evidence was deleted or weakened.

## Scope and unresolved targets

Defaults remain a 30-second liveness expiration and 15-second assignment refresh. Those defaults cannot promise five-second crash failover; a five-second clean handoff is a different measurement. T6 must name the move type, configuration, tail shape, runtime and host. Results are local to `dallens-mbp.lan`, Dallen's MacBook Pro, macOS arm64, with Bun 1.4.2 and Node 26.7.0, not Fly or a production storage provider.

Cloud must persist the drain report, arrange a wake from its earliest non-null `nextDue`, deliver stable store-scoped peer credentials to both rollout releases, retain and launch the matching old build after an unclean handoff, and validate the actual provider. General tenant addressing, suspend-safe clock-discontinuity detection, connection cleanup after owner loss and workflow compatibility remain their owning milestones' evidence, not passes on this page.

Effect 4.0.3 remains pinned. The upstream `Sharding.make` `pendingNotifications` temporal-dead-zone issue is [Effect-TS/effect#9068](https://github.com/Effect-TS/effect/issues/9068). The E3 engine simulator does not exercise that Cluster startup path under seeded scheduling; any observed real-run occurrence and workaround must be recorded with the process results rather than treating its absence here as a proof.
