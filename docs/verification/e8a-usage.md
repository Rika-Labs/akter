# E8a engine usage attribution

**Status:** runner-local framework evidence, merged into `rewrite/0.2` in [#775](https://github.com/Rika-Labs/akter/pull/775) and now on `main`; no hosted ingestion, billing or object-provider support claim.

## Public read and drain wire

The server entry exports `Telemetry.usage` and the types `UsageSnapshot`, `ActorUsage` and `UsageTotals`. `Telemetry.usage` is `Effect<UsageSnapshot, never, RuntimeControl>`; `Akter.serve` provides the context. Each read is detached, monotonic since runner open, and includes every declared actor type:

```ts
interface UsageSnapshot {
  readonly actions: number
  readonly jobSeconds: number
  readonly actors: ReadonlyArray<{
    readonly actorType: string
    readonly actions: number
    readonly jobSeconds: number
  }>
}
```

The cloud can vendor this backward-compatible `DrainReport` wire:

```ts
{
  outcome: "clean" | "timedOut",
  shards: ReadonlyArray<{ shard: number; offset: number; nextDue: number | null }>,
  actions?: number,
  jobSeconds?: number,
}
```

Both optional fields are nonnegative integers, cumulative for the whole runner, including work on previously released or lost shards. Missing values in legacy reports mean unknown, not zero. The host supplies a runner-incarnation identity and derives interval deltas; the read does not reset, seal or sign attribution.

Successful actions enter usage synchronously after append confirmation, before publication, never from admission, execution or replay. The existing diagnostic `akter.actions` outcome series still include declared failures and defects. Attempts start only after durable admission; elapsed local execution time is measured with the Effect clock and rounded up independently at settlement. Active attempts, concurrency queues, retry backoff and cleanup do not contribute. The attempt finalizer settles interruptions before shard scope closure, so clean and timed-out drain reports include the local share. Resumption begins its own interval rather than charging the previous runner's time or downtime from `Attempt.at`.

## Failure evidence

`packages/akter/src/runtime/telemetry/usage.test.ts` exercises real engine/commit/recovery behavior over the seeded `Simulation` bucket and `TestClock`; the storage boundary is not mocked.

| Plausible wrong implementation                                            | Scenario rejecting it                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counting replay, admissions or completions                                | Seeds 8101–8103 commit an action, retry its command id, record declared failure and defect, crash/replay the tail and move it to a new runner. Only new successful commits change usage. Simulator double execution cannot double the count. |
| Counting each PageMiss execution                                          | Seed 8110 checkpoints a list, moves ownership, proves a cold range throws `PageMiss`, then executes the action through normal resolution. The asymmetric values 7 and 13 produce 20 with exactly one action counted.                         |
| Counting attempted appends                                                | Seed 8120 crashes before writing and leaves zero usage until a real retry commits. A separate lost-response run resolves the written segment identity and counts exactly one, including after duplicate retry.                               |
| Counting held or fenced writes                                            | Seed 8121 holds a stale owner's append while the next owner opens; the held and then lost append contributes zero on either runner.                                                                                                          |
| Rounding the sum, charging backoff, or ignoring failed/defective attempts | Seed 8130 executes a 1.2-second failure or defect, waits for durable retry/backoff, then executes a 0.3-second success. The result is 3 seconds, not 2. The first settled interval is 2 before the second settles.                           |
| Charging previous-owner time again or omitting interruption               | Seed 8131 holds a running attempt through 1.2 seconds, then cleanly drains, times drain out, or loses ownership. The old runner/report has 2 seconds; the resumed same attempt on a new runner adds only its 0.3-second share, rounded to 1. |
| Ignoring timeout settlement or billing failure cleanup                    | Seed 8132 times out at 1.2 seconds and reports 2 job seconds, with the distinct successful failure-action commit included in actions.                                                                                                        |
| Mixing actor types or exposing mutable counter state                      | Seed 8140 gives two types asymmetric action totals, 1 and 2; the runner total is 3. The replay tests retain an older snapshot unchanged across later commits.                                                                                |
| Breaking legacy drain decoders                                            | The schema test decodes legacy and extended reports; negative actions and fractional job seconds are rejected. The packaged-consumer smoke reads typed usage from a real served runtime and checks drain after HTTP and WebSocket commits.   |

## Verification commands

Heavy commands run through `~/.capy/work/akter-launch/heavy.sh` on Dallen's Mac:

```sh
bun run check:static
bun run typecheck
bun run lint
bun run --cwd packages/akter test
node node_modules/vitest/vitest.mjs run packages/akter/src --exclude packages/akter/src/store/s3.test.ts --exclude packages/akter/src/runtime/cluster-process.test.ts
bun run pack:smoke
SMOKE_RUNTIME=node bun run pack:smoke
```

The package suites include the 1,000 fixed-owner and 200 moving-owner seed matrix, plus deterministic-repeat evidence, under Bun and Node. No store implementation or bucket protocol changed, so this change does not require the MinIO store shard. Simulator/filesystem/package results do not establish R2, Tigris or AWS behavior. Cloud reconciliation and sealing remain separate work.

An abrupt process kill cannot run finalizers or deliver its final snapshot. A segment durable immediately before process death can also be recovered without entering the dead runner's observed totals. These are attribution gaps for platform reconciliation, not a reason to bill replay. Suspension/clock discontinuity and provider accounting remain their existing external evidence gates.
