import { Effect } from "effect"
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
}

const segmentShard = /^s\/(\d+)\/log\//u

/**
 * A memory bucket behind seeded faults, for the simulator. Faults stay off until `arm`, so the
 * store's own setup is not disturbed. A crash calls the owner's crash hook for the shard whose log
 * is being written, as the process dying at that point would, and fails the call, which the dying
 * owner never sees answered. `inspect` reads the same objects without faults.
 */
const make = (
  random: () => number,
  faults: ReadonlyArray<Fault>,
  rates: FaultRates = defaultRates,
) => {
  const raw = memoryBucket()
  let armed = false
  let outage = 0
  let crashes = 0
  let lostResponses = 0
  let outages = 0
  let crash: (shard: number) => Effect.Effect<void> = () => Effect.void

  const strikes = (fault: Fault, rate: number): boolean =>
    armed && faults.includes(fault) && random() < rate

  const failure = (operation: string, key: string, status: number, reason: string) =>
    StorageUnavailable.make({ operation, key, status, reason })

  const intercept = <A>(
    operation: string,
    key: string,
    perform: Effect.Effect<A, StorageUnavailable>,
    write: boolean,
  ): Effect.Effect<A, StorageUnavailable> =>
    Effect.gen(function* () {
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
        yield* crash(Number(shard))
        return yield* failure(operation, key, 503, "the owner crashed before writing")
      }
      const result = yield* perform
      if (shard !== undefined && strikes("crash", rates.crashAfter)) {
        crashes++
        yield* crash(Number(shard))
        return yield* failure(operation, key, 504, "the owner crashed after writing")
      }
      if (write && strikes("lostResponse", rates.lostResponse)) {
        lostResponses++
        return yield* failure(operation, key, 504, "simulated lost response")
      }
      return result
    })

  const bucket: Bucket = {
    get: (key) => intercept("get", key, raw.get(key), false),
    head: (key) => intercept("head", key, raw.head(key), false),
    modified: (key) => intercept("modified", key, raw.modified(key), false),
    create: (key, body) => intercept("create", key, raw.create(key, body), true),
    put: (key, body) => intercept("put", key, raw.put(key, body), true),
    list: (prefix, options) => intercept("list", prefix, raw.list(prefix, options), false),
    delete: (keys) => intercept("delete", keys[0] ?? "", raw.delete(keys), true),
    leases: raw.leases,
  }

  return {
    bucket,
    inspect: raw,
    arm: (onCrash: (shard: number) => Effect.Effect<void>): void => {
      crash = onCrash
      armed = true
    },
    counts: (): FaultCounts => ({ crashes, lostResponses, outages }),
  }
}

/** The simulator's bucket. */
export const SimulatedBucket = { make }

/** The simulator's bucket with its fault hooks and counts. */
export type SimulatedBucket = ReturnType<typeof make>
