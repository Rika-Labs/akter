import { Effect } from "effect"
import { LogUnavailable, OwnerCrashed, StaleEpoch } from "../execution/log.ts"
import type { LogService } from "../execution/log.ts"
import type { StoredSegment } from "../snapshots/recovery.ts"

/** A fault the simulator can inject into the log. */
export type Fault = "crash" | "lostResponse" | "slowLog"

/**
 * How often each fault strikes one log call, as a probability. A slow call waits up to
 * `maxDelayTurns` scheduler turns, so other fibers run meanwhile without the clock moving.
 */
export interface FaultRates {
  readonly crashBefore: number
  readonly crashAfter: number
  readonly lostResponse: number
  readonly slow: number
  readonly maxDelayTurns: number
}

/** Default fault rates: rare crashes, occasional lost responses, frequent short delays. */
export const defaultRates: FaultRates = {
  crashBefore: 0.03,
  crashAfter: 0.03,
  lostResponse: 0.05,
  slow: 0.3,
  maxDelayTurns: 20,
}

type Slot =
  | { readonly kind: "open"; readonly epoch: number }
  | { readonly kind: "data"; readonly epoch: number; readonly bytes: Uint8Array }

interface ShardLog {
  readonly slots: Map<number, Slot>
  head: number
  epoch: number
  readonly checkpoints: Array<StoredSegment & { readonly epoch: number }>
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * An in-process log with the bucket protocol's semantics: open creates the next slot once and
 * becomes the epoch, append creates exactly the slot after the head once, a retried append that
 * finds its own bytes succeeds, and anything else is `StaleEpoch`. Faults strike appends with
 * seeded probabilities; `violations` records any append that a fenced owner managed to make.
 */
const make = (random: () => number, faults: ReadonlyArray<Fault>, rates: FaultRates = defaultRates) => {
  const shards = new Map<number, ShardLog>()
  const violations: Array<string> = []
  let appends = 0
  let crashes = 0
  let lostResponses = 0

  const shardLog = (shard: number): ShardLog => {
    const existing = shards.get(shard)
    if (existing !== undefined) return existing
    const created: ShardLog = { slots: new Map(), head: -1, epoch: -1, checkpoints: [] }
    shards.set(shard, created)
    return created
  }

  const strikes = (fault: Fault, rate: number): boolean => faults.includes(fault) && random() < rate

  const delay = (): Effect.Effect<void> =>
    strikes("slowLog", rates.slow)
      ? Effect.repeat(Effect.yieldNow, { times: Math.floor(random() * rates.maxDelayTurns) })
      : Effect.void

  const segments = (log: ShardLog, after: number): Array<StoredSegment> =>
    Array.from(log.slots)
      .filter((entry): entry is [number, Extract<Slot, { readonly kind: "data" }>] => entry[0] > after && entry[1].kind === "data")
      .sort(([left], [right]) => left - right)
      .map(([offset, slot]) => ({ offset, bytes: slot.bytes }))

  const service: LogService = {
    open: (shard) =>
      Effect.andThen(
        delay(),
        Effect.sync(() => {
          const log = shardLog(shard)
          const epoch = log.head + 1
          log.slots.set(epoch, { kind: "open", epoch })
          log.head = epoch
          log.epoch = epoch
          const checkpoint = log.checkpoints.at(-1)
          return {
            lease: { shard, epoch },
            checkpoint: checkpoint?.bytes,
            tail: segments(log, checkpoint?.offset ?? -1).filter((segment) => segment.offset < epoch),
          }
        }),
      ),
    append: (lease, offset, bytes) =>
      Effect.andThen(
        delay(),
        Effect.suspend((): Effect.Effect<void, StaleEpoch | LogUnavailable | OwnerCrashed> => {
          const log = shardLog(lease.shard)
          if (strikes("crash", rates.crashBefore)) {
            crashes++
            return Effect.fail(OwnerCrashed.make({ shard: lease.shard, written: false }))
          }
          const existing = log.slots.get(offset)
          if (existing !== undefined) {
            if (existing.kind === "data" && existing.epoch === lease.epoch && sameBytes(existing.bytes, bytes))
              return Effect.void
            return Effect.fail(StaleEpoch.make({ shard: lease.shard, epoch: lease.epoch }))
          }
          if (offset !== log.head + 1) return Effect.fail(StaleEpoch.make({ shard: lease.shard, epoch: lease.epoch }))
          if (lease.epoch !== log.epoch)
            violations.push(`I1: shard ${lease.shard} offset ${offset} appended by epoch ${lease.epoch} while epoch ${log.epoch} owns it`)
          log.slots.set(offset, { kind: "data", epoch: lease.epoch, bytes })
          log.head = offset
          appends++
          if (strikes("crash", rates.crashAfter)) {
            crashes++
            return Effect.fail(OwnerCrashed.make({ shard: lease.shard, written: true }))
          }
          if (strikes("lostResponse", rates.lostResponse)) {
            lostResponses++
            return Effect.fail(LogUnavailable.make({ shard: lease.shard, ambiguous: true }))
          }
          return Effect.void
        }),
      ),
    checkpoint: (lease, offset, bytes) =>
      Effect.suspend(() => {
        const log = shardLog(lease.shard)
        if (lease.epoch !== log.epoch) return Effect.fail(StaleEpoch.make({ shard: lease.shard, epoch: lease.epoch }))
        log.checkpoints.push({ offset, bytes, epoch: lease.epoch })
        return Effect.void
      }),
    read: (shard) =>
      Effect.sync(() => {
        const log = shardLog(shard)
        return { checkpoints: log.checkpoints.map(({ offset, bytes }) => ({ offset, bytes })), segments: segments(log, -1) }
      }),
  }

  return {
    service,
    violations,
    segment: (shard: number, offset: number): Uint8Array | undefined => {
      const slot = shards.get(shard)?.slots.get(offset)
      return slot?.kind === "data" ? slot.bytes : undefined
    },
    shards: (): ReadonlyArray<number> => Array.from(shards.keys()),
    stats: () => ({ appends, crashes, lostResponses }),
  }
}

/** The simulator's in-process log. */
export const MemoryLog = { make }

/** The simulator's in-process log with its fault hooks and observations. */
export type MemoryLog = ReturnType<typeof make>
