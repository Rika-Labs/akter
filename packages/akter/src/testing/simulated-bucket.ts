import { Clock, Duration, Effect } from "effect"
import type { Bucket } from "../store/bucket.ts"
import { StorageUnavailable } from "../store/errors.ts"
import { memoryBucket } from "../store/memory.ts"

/** A fault the simulator can inject between the store and its bucket. */
export type Fault = "crash" | "lostResponse" | "unavailable" | "slowLog"

/**
 * How often each fault strikes one bucket call, as a probability. A crash strikes only log segment
 * writes, before the write reaches the bucket or after it is stored; an outage fails the striking
 * call and up to `maxOutage - 1` calls after it, so some outlast the store's retries; a slow call
 * waits up to `maxDelayTurns` scheduler turns, so other fibers run meanwhile without the clock
 * moving.
 */
export interface FaultRates {
  readonly crashBefore: number
  readonly crashAfter: number
  readonly lostResponse: number
  readonly unavailable: number
  readonly maxOutage: number
  readonly slow: number
  readonly maxDelayTurns: number
}

/** Default fault rates: rare crashes and outages, occasional lost responses, frequent short delays. */
export const defaultRates: FaultRates = {
  crashBefore: 0.03,
  crashAfter: 0.03,
  lostResponse: 0.05,
  unavailable: 0.02,
  maxOutage: 8,
  slow: 0.3,
  maxDelayTurns: 20,
}

/** How many times each fault struck. */
export interface FaultCounts {
  readonly crashes: number
  readonly lostResponses: number
  readonly outages: number
  readonly partitioned: number
  readonly paused: number
}

const segmentShard = /^s\/(\d+)\/log\//u

/**
 * A fault a test aims at one call: the next call `runner` makes that `match`es is struck once. A
 * crash calls the crash hook for `shard`, or for the shard of the log segment being written.
 */
export interface ScriptedFault {
  readonly runner: number
  readonly fault: "crashBefore" | "crashAfter" | "lostResponse" | "unavailable"
  readonly match: (operation: string, key: string) => boolean
  readonly shard?: number
}

/** Until when one runner is cut off from the bucket or paused, in test-clock milliseconds. */
interface Isolation {
  partitionedUntil: number
  pausedUntil: number
}

/**
 * A memory bucket behind seeded faults, for the simulator, seen by each runner through its own
 * view. Faults stay off until `arm`, so the stores' own setup is not disturbed. A crash calls the
 * crash hook for the runner and shard whose log is being written, as that process dying at that
 * point would, and fails the call, which the dying owner never sees answered. A partitioned runner's
 * calls fail without reaching the bucket; a paused runner's calls wait until the pause ends and then
 * reach the bucket, the way requests a frozen process sent land late. A scripted fault strikes the
 * one call a test aims it at, so a scenario can crash an owner at a chosen step. `inspect` reads the
 * same objects without faults.
 */
const make = (
  random: () => number,
  faults: ReadonlyArray<Fault>,
  rates: FaultRates = defaultRates,
) => {
  const raw = memoryBucket()
  const isolations = new Map<number, Isolation>()
  const scripted: Array<ScriptedFault> = []
  let armed = false
  let outage = 0
  let crashes = 0
  let lostResponses = 0
  let outages = 0
  let partitioned = 0
  let paused = 0
  let crash: (runner: number, shard: number) => Effect.Effect<void> = () => Effect.void

  const isolation = (runner: number): Isolation => {
    const existing = isolations.get(runner)
    if (existing !== undefined) return existing
    const created = { partitionedUntil: 0, pausedUntil: 0 }
    isolations.set(runner, created)
    return created
  }

  const strikes = (fault: Fault, rate: number): boolean =>
    armed && faults.includes(fault) && random() < rate

  const failure = (operation: string, key: string, status: number, reason: string) =>
    StorageUnavailable.make({ operation, key, status, reason })

  const intercept = <A>(
    runner: number,
    operation: string,
    key: string,
    perform: Effect.Effect<A, StorageUnavailable>,
    write: boolean,
  ): Effect.Effect<A, StorageUnavailable> =>
    Effect.gen(function* () {
      const cut = isolation(runner)
      const before = yield* Clock.currentTimeMillis
      if (before < cut.pausedUntil) {
        paused++
        yield* Effect.sleep(Duration.millis(cut.pausedUntil - before))
      }
      if ((yield* Clock.currentTimeMillis) < cut.partitionedUntil) {
        partitioned++
        return yield* failure(operation, key, 503, "simulated partition")
      }
      const aimed = scripted.findIndex(
        (candidate) => candidate.runner === runner && candidate.match(operation, key),
      )
      const struck = aimed >= 0 ? scripted.splice(aimed, 1)[0] : undefined
      if (struck !== undefined) {
        const { fault, shard } = struck
        const crashing = shard ?? Number(segmentShard.exec(key)?.[1] ?? Number.NaN)
        if (fault === "unavailable") {
          outages++
          return yield* failure(operation, key, 503, "scripted outage")
        }
        if (fault === "crashBefore") {
          crashes++
          yield* crash(runner, crashing)
          return yield* failure(operation, key, 503, "the owner crashed before writing")
        }
        yield* perform
        if (fault === "lostResponse") {
          lostResponses++
          return yield* failure(operation, key, 504, "scripted lost response")
        }
        crashes++
        yield* crash(runner, crashing)
        return yield* failure(operation, key, 504, "the owner crashed after writing")
      }
      if (strikes("slowLog", rates.slow))
        yield* Effect.repeat(Effect.yieldNow, { times: Math.floor(random() * rates.maxDelayTurns) })
      if (outage > 0) {
        outage--
        return yield* failure(operation, key, 503, "simulated outage")
      }
      if (strikes("unavailable", rates.unavailable)) {
        outages++
        outage = Math.floor(random() * rates.maxOutage)
        return yield* failure(operation, key, 503, "simulated outage")
      }
      const shard = operation === "create" ? segmentShard.exec(key)?.[1] : undefined
      if (shard !== undefined && strikes("crash", rates.crashBefore)) {
        crashes++
        yield* crash(runner, Number(shard))
        return yield* failure(operation, key, 503, "the owner crashed before writing")
      }
      const result = yield* perform
      if (shard !== undefined && strikes("crash", rates.crashAfter)) {
        crashes++
        yield* crash(runner, Number(shard))
        return yield* failure(operation, key, 504, "the owner crashed after writing")
      }
      if (write && strikes("lostResponse", rates.lostResponse)) {
        lostResponses++
        return yield* failure(operation, key, 504, "simulated lost response")
      }
      return result
    })

  /** The bucket as one runner reaches it. */
  const view = (runner: number): Bucket => ({
    get: (key) => intercept(runner, "get", key, raw.get(key), false),
    head: (key) => intercept(runner, "head", key, raw.head(key), false),
    modified: (key) => intercept(runner, "modified", key, raw.modified(key), false),
    create: (key, body) => intercept(runner, "create", key, raw.create(key, body), true),
    put: (key, body) => intercept(runner, "put", key, raw.put(key, body), true),
    list: (prefix, options) => intercept(runner, "list", prefix, raw.list(prefix, options), false),
    delete: (keys) => intercept(runner, "delete", keys[0] ?? "", raw.delete(keys), true),
    leases: raw.leases,
  })

  return {
    view,
    inspect: raw,
    arm: (onCrash: (runner: number, shard: number) => Effect.Effect<void>): void => {
      crash = onCrash
      armed = true
    },
    /** Cuts `runner` off from the bucket until test-clock time `until`. */
    partition: (runner: number, until: number): void => {
      isolation(runner).partitionedUntil = until
    },
    /** Strikes the next matching call of one runner with `fault`, once, ahead of the seeded faults. */
    script: (fault: ScriptedFault): void => {
      scripted.push(fault)
    },
    /** Holds every call `runner` makes until test-clock time `until`. */
    pause: (runner: number, until: number): void => {
      isolation(runner).pausedUntil = until
    },
    counts: (): FaultCounts => ({ crashes, lostResponses, outages, partitioned, paused }),
  }
}

/** The simulator's bucket. */
export const SimulatedBucket = { make }

/** The simulator's bucket with its fault hooks and counts. */
export type SimulatedBucket = ReturnType<typeof make>
