import { Clock, Effect, Option, Random, Result } from "effect"
import { type Bucket, Condition } from "./bucket.ts"

/** How hard the probe pushes the bucket. */
export interface CheckOptions {
  /** Concurrent writers in each race round. Default 16. */
  readonly writers?: number
  /** Rounds of each race and of the listing probe. Default 10. */
  readonly rounds?: number
  /** Back-to-back writes to one key in the write-rate probe. Default 10. */
  readonly writes?: number
}

/** One probe's verdict and what it observed. */
export interface Probe {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

/** Every probe's verdict; the bucket is supported only when all passed. */
export interface CheckReport {
  readonly passed: boolean
  readonly probes: ReadonlyArray<Probe>
}

/** Statuses a provider returns when one key or the bucket is written too fast. */
const THROTTLE_STATUSES = new Set([429, 503])

const DELETED_KEYS = 50

const encoder = new TextEncoder()

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * The conformance probe that defines a supported bucket for Akter: the log's
 * fence needs create-once writes that never let two concurrent creators both
 * succeed, runner leases need compare-and-swap on etags, open needs listings
 * that show every completed write, and trim needs batch deletes. The probe
 * also records how the bucket treats rapid writes to one key, which bounds
 * heartbeat rates. It writes only under `check/<run>/` and removes what it
 * wrote.
 */
export const checkBucket =
  (bucket: Bucket) =>
  (options: CheckOptions = {}) =>
    Effect.gen(function* () {
      const writers = options.writers ?? 16
      const rounds = options.rounds ?? 10
      const writes = options.writes ?? 10
      const run = `check/${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16)}${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16)}/`
      const leaseKeys: Array<string> = []
      const objectKeys: Array<string> = []

      const conditionalCreate = Effect.gen(function* () {
        let doubles = 0
        let unknown = 0
        let lost = 0
        for (let round = 0; round < rounds; round++) {
          const key = `${run}create/${round}`
          objectKeys.push(key)
          const bodies = Array.from({ length: writers }, (_, writer) =>
            encoder.encode(`create ${round} ${writer}`),
          )
          const results = yield* Effect.forEach(
            bodies,
            (body) => Effect.result(bucket.create(key, body)),
            {
              concurrency: "unbounded",
            },
          )
          const winners: Array<number> = []
          results.forEach((result, writer) => {
            if (Result.isFailure(result)) unknown += 1
            else if (result.success) winners.push(writer)
          })
          if (winners.length > 1) doubles += 1
          const stored = yield* bucket.get(key)
          const winner = winners[0]
          if (
            winner !== undefined &&
            !Option.exists(stored, (bytes) => bytesEqual(bytes, bodies[winner] ?? new Uint8Array()))
          )
            lost += 1
        }
        return {
          name: "conditional create race",
          passed: doubles === 0 && lost === 0,
          detail: `${writers} writers x ${rounds} rounds: ${doubles} rounds with two successful creators, ${lost} winners not stored, ${unknown} unanswered writes`,
        }
      })

      const compareAndSwap = Effect.gen(function* () {
        let doubles = 0
        let lost = 0
        let unknown = 0
        const key = `${run}swap`
        leaseKeys.push(key)
        const first = yield* bucket.leases.write(
          key,
          encoder.encode("swap start"),
          Condition.Absent(),
        )
        if (Option.isNone(first))
          return {
            name: "compare-and-swap race",
            passed: false,
            detail: "the probe key already existed",
          }
        let etag = first.value
        for (let round = 0; round < rounds; round++) {
          const bodies = Array.from({ length: writers }, (_, writer) =>
            encoder.encode(`swap ${round} ${writer}`),
          )
          const results = yield* Effect.forEach(
            bodies,
            (body) => Effect.result(bucket.leases.write(key, body, Condition.Matches({ etag }))),
            { concurrency: "unbounded" },
          )
          const winners: Array<number> = []
          results.forEach((result, writer) => {
            if (Result.isFailure(result)) unknown += 1
            else if (Option.isSome(result.success)) winners.push(writer)
          })
          if (winners.length > 1) doubles += 1
          const current = yield* bucket.leases.read(key)
          if (Option.isNone(current))
            return {
              name: "compare-and-swap race",
              passed: false,
              detail: "the probe key vanished",
            }
          const winner = winners[0]
          if (
            winner !== undefined &&
            !bytesEqual(current.value.body, bodies[winner] ?? new Uint8Array())
          )
            lost += 1
          etag = current.value.etag
        }
        return {
          name: "compare-and-swap race",
          passed: doubles === 0 && lost === 0,
          detail: `${writers} writers x ${rounds} rounds: ${doubles} rounds with two successful swaps, ${lost} winners not stored, ${unknown} unanswered writes`,
        }
      })

      const listAfterWrite = Effect.gen(function* () {
        let missing = 0
        let lingering = 0
        for (let round = 0; round < rounds; round++) {
          const key = `${run}listed/${round}`
          objectKeys.push(key)
          yield* bucket.create(key, encoder.encode(`listed ${round}`))
          if (!(yield* bucket.list(`${run}listed/`)).includes(key)) missing += 1
          yield* bucket.delete([key])
          if ((yield* bucket.list(`${run}listed/`)).includes(key)) lingering += 1
        }
        return {
          name: "list after write",
          passed: missing === 0 && lingering === 0,
          detail: `${rounds} rounds: ${missing} created keys missing from the next listing, ${lingering} deleted keys still listed`,
        }
      })

      const writeRate = Effect.gen(function* () {
        const key = `${run}rate`
        leaseKeys.push(key)
        let throttled = 0
        let failed = 0
        let last = Option.none<Uint8Array>()
        const started = yield* Clock.currentTimeMillis
        for (let write = 0; write < writes; write++) {
          const body = encoder.encode(`rate ${write}`)
          const result = yield* Effect.result(bucket.leases.write(key, body, Condition.Always()))
          if (Result.isSuccess(result)) last = Option.some(body)
          else if (THROTTLE_STATUSES.has(result.failure.status ?? 0)) throttled += 1
          else failed += 1
        }
        const elapsed = (yield* Clock.currentTimeMillis) - started
        const stored = yield* bucket.leases.read(key)
        const kept =
          Option.isNone(last) ||
          Option.exists(stored, (current) =>
            Option.exists(last, (body) => bytesEqual(current.body, body)),
          )
        return {
          name: "per-key write rate",
          passed: failed === 0 && kept,
          detail: `${writes} back-to-back writes to one key in ${elapsed} ms: ${throttled} throttled, ${failed} failed otherwise, last accepted write ${kept ? "stored" : "not stored"}`,
        }
      })

      const deleteBatch = Effect.gen(function* () {
        const keys = Array.from(
          { length: DELETED_KEYS },
          (_, index) => `${run}deleted/${String(index).padStart(3, "0")}`,
        )
        objectKeys.push(...keys)
        yield* Effect.forEach(keys, (key) => bucket.create(key, encoder.encode(key)), {
          concurrency: 16,
          discard: true,
        })
        const before = (yield* bucket.list(`${run}deleted/`)).length
        yield* bucket.delete(keys)
        const after = (yield* bucket.list(`${run}deleted/`)).length
        return {
          name: "batch delete",
          passed: before === DELETED_KEYS && after === 0,
          detail: `${before} of ${DELETED_KEYS} keys listed before one batch delete, ${after} after`,
        }
      })

      const probes = yield* Effect.all([
        conditionalCreate,
        compareAndSwap,
        listAfterWrite,
        writeRate,
        deleteBatch,
      ]).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.all([
              bucket.delete(objectKeys),
              Effect.forEach(leaseKeys, (key) => bucket.leases.remove(key)),
            ]),
          ).pipe(Effect.ignore),
        ),
      )
      return { passed: probes.every((probe) => probe.passed), probes } satisfies CheckReport
    })
