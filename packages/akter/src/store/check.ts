import { Clock, Duration, Effect, Option, Random, Result } from "effect"
import { type Bucket, Condition } from "./bucket.ts"
import type { StorageUnavailable } from "./errors.ts"

/** How hard the probe pushes the bucket. */
export interface CheckOptions {
  /** Concurrent writers in each race round. Default 16. */
  readonly writers?: number
  /** Rounds of each race and of the listing probe. Default 10. */
  readonly rounds?: number
  /** Back-to-back writes to one key in the write-rate probe. Default 10. */
  readonly writes?: number
  /** Wait between the two identical writes of the last-modified probe; it must exceed the provider's timestamp resolution, one second on S3. Default 2 seconds. */
  readonly settle?: Duration.Input
}

/** One probe's verdict and what it observed. */
export interface Probe {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
  /** The numbers behind the verdict, such as rounds raced, violations seen and milliseconds elapsed. */
  readonly measured: Readonly<Record<string, number>>
}

/** Every probe's verdict; the bucket is supported only when all passed. */
export interface CheckReport {
  readonly passed: boolean
  readonly probes: ReadonlyArray<Probe>
}

/** Statuses a provider returns when one key or the bucket is written too fast. */
const THROTTLE_STATUSES = new Set([429, 503])

const DELETED_KEYS = 50

/**
 * Key names for the listing-order probe, created out of order. Some are prefixes of others and
 * some sort around digits and letters; none differ only by case, so a case-insensitive file system
 * can hold them all.
 */
const ORDERED_NAMES = ["m", "a", "10", "9", "_", "z", "0", "-", "1", "a.b", "b", "1a"]

const ORDERED_PAGE = 5

const byteOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

const encoder = new TextEncoder()

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * The conformance probe that defines a supported bucket for Akter: the log's
 * fence needs create-once writes that never let two concurrent creators both
 * succeed, runner leases need compare-and-swap on etags, open needs listings
 * that show every completed write and return keys in byte order through
 * `limit` and `startAfter`, garbage collection needs a plain `PUT` to
 * refresh last-modified, and trim needs batch deletes. The probe also records
 * how the bucket treats rapid writes to one key, which bounds heartbeat
 * rates. It writes only under `check/<run>/` and removes what it wrote.
 */
export const checkBucket =
  (bucket: Bucket) =>
  (options: CheckOptions = {}) =>
    Effect.gen(function* () {
      const writers = options.writers ?? 16
      const rounds = options.rounds ?? 10
      const writes = options.writes ?? 10
      const settle = Duration.toMillis(Duration.fromInputUnsafe(options.settle ?? "2 seconds"))
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
          measured: {
            writers,
            rounds,
            doubleWinners: doubles,
            lostWinners: lost,
            unanswered: unknown,
          },
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
            measured: { writers, rounds, doubleWinners: 0, lostWinners: 0, unanswered: 0 },
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
              measured: {
                writers,
                rounds,
                doubleWinners: doubles,
                lostWinners: lost,
                unanswered: unknown,
              },
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
          measured: {
            writers,
            rounds,
            doubleWinners: doubles,
            lostWinners: lost,
            unanswered: unknown,
          },
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
          measured: { rounds, missingFromListing: missing, lingeringInListing: lingering },
        }
      })

      const orderedListing = Effect.gen(function* () {
        const prefix = `${run}ordered/`
        const keys = ORDERED_NAMES.map((name) => `${prefix}${name}`)
        objectKeys.push(...keys)
        yield* Effect.forEach(keys, (key) => bucket.create(key, encoder.encode(key)), {
          concurrency: 4,
          discard: true,
        })
        const expected = keys.toSorted(byteOrder)
        const full = yield* bucket.list(prefix)
        const paged: Array<string> = []
        let pages = 0
        let oversized = 0
        while (pages <= expected.length) {
          const after = paged[paged.length - 1]
          const page = yield* bucket.list(
            prefix,
            after === undefined
              ? { limit: ORDERED_PAGE }
              : { limit: ORDERED_PAGE, startAfter: after },
          )
          pages += 1
          if (page.length === 0) break
          if (page.length > ORDERED_PAGE) oversized += 1
          paged.push(...page)
        }
        const same = (found: ReadonlyArray<string>) =>
          found.length === expected.length && found.every((key, index) => key === expected[index])
        return {
          name: "ordered listing with limit and start-after",
          passed: same(full) && same(paged) && oversized === 0,
          detail: `${keys.length} keys created out of order: the full listing is ${same(full) ? "in byte order" : "not in byte order"}; ${pages} pages of at most ${ORDERED_PAGE} by start-after ${same(paged) ? "return every key once, in order" : "do not return every key once, in order"}, ${oversized} pages over the limit`,
          measured: {
            keys: keys.length,
            pageSize: ORDERED_PAGE,
            pages,
            fullListingInOrder: same(full) ? 1 : 0,
            pagedKeys: paged.length,
            oversizedPages: oversized,
          },
        }
      })

      const lastModified = Effect.gen(function* () {
        const key = `${run}modified`
        objectKeys.push(key)
        const body = encoder.encode("modified")
        yield* bucket.put(key, body)
        const first = yield* bucket.modified(key)
        yield* Effect.sleep(settle)
        yield* bucket.put(key, body)
        const second = yield* bucket.modified(key)
        if (Option.isNone(first) || Option.isNone(second))
          return {
            name: "overwrite refreshes last-modified",
            passed: false,
            detail: "a written key has no last-modified time",
            measured: { settleMillis: settle, advancedMillis: 0 },
          }
        const advanced = second.value - first.value
        return {
          name: "overwrite refreshes last-modified",
          passed: advanced > 0,
          detail: `a plain PUT of identical bytes ${settle} ms after the first moved last-modified by ${advanced} ms`,
          measured: { settleMillis: settle, advancedMillis: advanced },
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
          measured: { writes, writeMillis: elapsed, throttled, failed },
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
          measured: { keys: DELETED_KEYS, listedBefore: before, listedAfter: after },
        }
      })

      const timed = (
        probe: Effect.Effect<Probe, StorageUnavailable>,
      ): Effect.Effect<Probe, StorageUnavailable> =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis
          const verdict = yield* probe
          const elapsed = (yield* Clock.currentTimeMillis) - started
          return { ...verdict, measured: { ...verdict.measured, elapsedMillis: elapsed } }
        })

      const probes = yield* Effect.all([
        timed(conditionalCreate),
        timed(compareAndSwap),
        timed(listAfterWrite),
        timed(orderedListing),
        timed(lastModified),
        timed(writeRate),
        timed(deleteBatch),
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
