import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Result, Schedule, type Scope, Stream } from "effect"
import * as Runner from "effect/cluster/Runner"
import * as RunnerAddress from "effect/cluster/RunnerAddress"
import * as ShardId from "effect/cluster/ShardId"
import * as ShardingConfig from "effect/cluster/ShardingConfig"
import { TestClock } from "effect/testing"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import {
  CorruptSegment,
  MissingPage,
  StaleEpoch,
  StoreUnavailable,
} from "../../../../packages/akter/src/store/errors.ts"
import { Fault, Faults, type Operation } from "../../../../packages/akter/src/store/faults.ts"
import {
  checkpointPrefix,
  pageKey,
  PAGES_PREFIX,
  segmentKey,
} from "../../../../packages/akter/src/store/keys.ts"
import { Store, storeOf, type StoreOptions } from "../../../../packages/akter/src/store/layer.ts"
import { runnerDefaults, runnerStorage } from "../../../../packages/akter/src/store/runners.ts"

/** A backend under test: `namespace` gives a fresh empty store location and a way to open clients on it. */
export interface StoreBackend<OpenError, ClientError> {
  readonly name: string
  readonly namespace: Effect.Effect<
    Effect.Effect<Bucket, ClientError, Scope.Scope>,
    OpenError,
    Scope.Scope
  >
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const text = (value: string) => encoder.encode(value)

/** No backoff, so retries never wait on the test clock. */
const RETRY = Schedule.recurs(4)

const VALID_FOR = "10 seconds"
const TRIM_AFTER = "10 minutes"

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => Option.getOrUndefined(Exit.findErrorOption(exit)))

const creates = (key: string) => (operation: Operation) =>
  operation.kind === "create" && operation.key === key

const owner = <E>(
  client: Effect.Effect<Bucket, E, Scope.Scope>,
  writer: string,
  options: StoreOptions = {},
) =>
  Effect.gen(function* () {
    const faults = Faults.plan()
    const store = yield* storeOf(yield* client, {
      writer,
      faults,
      retry: RETRY,
      shards: 4,
      validFor: VALID_FOR,
      trimAfter: TRIM_AFTER,
      ...options,
    })
    return { store, faults }
  })

/** Every segment after `from`, with entries decoded as text. */
const history = (store: Store["Service"], shard: number, from: bigint) =>
  Effect.map(Stream.runCollect(store.read(shard, from)), (segments) =>
    Array.from(segments, (segment) => ({
      offset: segment.offset,
      writer: segment.writer,
      open: segment.open,
      entries: segment.entries.map((entry) => decoder.decode(entry)),
    })),
  )

const shardIds = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => ShardId.make("default", from + index))

const ids = (shards: Iterable<ShardId.ShardId>) =>
  Array.from(shards, (shard) => shard.id).sort((a, b) => a - b)

const runnersOn = (store: Store["Service"]) =>
  runnerStorage.pipe(
    Effect.provideService(Store, store),
    Effect.provideService(ShardingConfig.ShardingConfig, {
      ...ShardingConfig.defaults,
      ...runnerDefaults,
    }),
  )

/**
 * The store protocol's conformance scenarios, run against one backend. Each
 * scenario names the wrong implementation it rejects. Owners are separate
 * store instances, each with its own client and fault plan, over one shared
 * location; time is the test clock.
 */
export const storeConformance = <OpenError, ClientError>(
  backend: StoreBackend<OpenError, ClientError>,
) =>
  describe(`Store on ${backend.name}`, () => {
    it.effect(
      "rejects a stale owner's append once another owner opened (rejects a fence kept only in memory or a plain PUT)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const leaseA = yield* a.store.open(0)
          expect(yield* a.store.append(leaseA, [text("a1")])).toBe(2n)
          const leaseB = yield* b.store.open(0)
          expect(leaseB.open).toBe(3n)

          expect(yield* failureOf(a.store.append(leaseA, [text("a2")]))).toBeInstanceOf(StaleEpoch)
          expect(yield* failureOf(a.store.verify(leaseA))).toBeInstanceOf(StaleEpoch)
          expect(yield* b.store.append(leaseB, [text("b1")])).toBe(4n)
          expect(yield* history(b.store, 0, 0n)).toEqual([
            { offset: 1n, writer: "a", open: 1n, entries: [] },
            { offset: 2n, writer: "a", open: 1n, entries: ["a1"] },
            { offset: 3n, writer: "b", open: 3n, entries: [] },
            { offset: 4n, writer: "b", open: 3n, entries: ["b1"] },
          ])
        }),
    )

    it.effect(
      "gives concurrent opens distinct epochs and lets exactly the newest append (rejects an open without create-once)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const owners = yield* Effect.forEach(["p", "q", "r", "s", "t", "u"], (writer) =>
            owner(client, writer),
          )
          const opened = yield* Effect.forEach(
            owners,
            ({ store }) => Effect.result(store.open(1)),
            {
              concurrency: "unbounded",
            },
          )
          const leases = opened.flatMap((result, index) => {
            const store = owners[index]?.store
            return Result.isSuccess(result) && store !== undefined
              ? [{ store, lease: result.success }]
              : []
          })
          for (const result of opened)
            if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(StaleEpoch)
          expect(leases.length).toBeGreaterThan(0)
          const epochs = leases.map(({ lease }) => lease.open)
          expect(new Set(epochs).size).toBe(epochs.length)

          const appended = yield* Effect.forEach(
            leases,
            ({ store, lease }) => Effect.result(store.append(lease, [text(`from ${lease.open}`)])),
            { concurrency: "unbounded" },
          )
          const winners = leases.filter((_, index) => {
            const result = appended[index]
            return result !== undefined && Result.isSuccess(result)
          })
          expect(winners.map(({ lease }) => lease.open)).toEqual([
            epochs.reduce((max, epoch) => (epoch > max ? epoch : max), 0n),
          ])
          for (const result of appended)
            if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(StaleEpoch)
        }),
    )

    it.effect(
      "recognizes its own append behind a lost response and stores it once (rejects retrying at the next offset or failing a committed write)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const lease = yield* a.store.open(0)
          const lost = yield* a.faults.inject(Fault.LoseResponse(), {
            match: creates(segmentKey(0, 2n)),
          })

          expect(yield* a.store.append(lease, [text("x")])).toBe(2n)
          yield* lost.fired
          expect(yield* a.store.append(lease, [text("y")])).toBe(3n)

          const attempts = (yield* a.faults.operations).filter(creates(segmentKey(0, 2n)))
          expect(attempts).toHaveLength(2)
          expect((yield* history(a.store, 0, 0n)).map((segment) => segment.entries)).toEqual([
            [],
            ["x"],
            ["y"],
          ])
        }),
    )

    it.effect(
      "fails a lost-response append that another owner overtook with StaleEpoch (rejects trusting every 412 after a retry)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const leaseA = yield* a.store.open(0)
          const held = yield* a.faults.inject(Fault.Hold(), { match: creates(segmentKey(0, 2n)) })
          yield* a.faults.inject(Fault.Unavailable({ status: 503 }), {
            match: creates(segmentKey(0, 2n)),
          })

          const appending = yield* Effect.forkChild(a.store.append(leaseA, [text("late")]))
          yield* held.fired
          const leaseB = yield* b.store.open(0)
          expect(leaseB.open).toBe(2n)
          yield* held.release

          const exit = yield* Fiber.await(appending)
          expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(StaleEpoch)
          expect((yield* history(b.store, 0, 0n)).map((segment) => segment.writer)).toEqual([
            "a",
            "b",
          ])
        }),
    )

    it.effect(
      "keeps the previous checkpoint authoritative after a crash between page writes and the manifest (rejects recovering from pages without a durable manifest)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const lease = yield* a.store.open(0)
          yield* a.store.append(lease, [text("b1")])
          yield* a.store.append(lease, [text("b2")])
          const first = yield* a.store.putPage(text("state through b2"))
          yield* a.store.checkpoint(lease, { offset: 3n, statePages: [first], indexPages: [] })
          yield* a.store.append(lease, [text("b3")])
          yield* a.store.append(lease, [text("b4")])
          const second = yield* a.store.putPage(text("state through b4"))
          yield* a.faults.inject(Fault.Unavailable({ status: 500 }), {
            match: (operation) =>
              operation.kind === "create" && operation.key.startsWith(checkpointPrefix(0)),
            times: Number.POSITIVE_INFINITY,
          })
          expect(
            yield* failureOf(
              a.store.checkpoint(lease, { offset: 5n, statePages: [second], indexPages: [] }),
            ),
          ).toBeInstanceOf(StoreUnavailable)

          const recovered = yield* b.store.open(0)
          const checkpoint = Option.getOrThrow(recovered.checkpoint)
          expect(checkpoint).toEqual({ offset: 3n, statePages: [first], indexPages: [] })
          expect(decoder.decode(yield* b.store.getPage(first))).toBe("state through b2")
          expect(decoder.decode(yield* b.store.getPage(second))).toBe("state through b4")
          expect(
            (yield* history(b.store, 0, checkpoint.offset)).map((segment) => segment.entries),
          ).toEqual([["b3"], ["b4"], []])
        }),
    )

    it.effect(
      "recovers every acknowledged batch in order from the newest checkpoint and the tail (rejects reading the oldest checkpoint, duplicates or reordering)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const lease = yield* a.store.open(2)
          const acknowledged: Array<readonly [bigint, string]> = []
          for (let batch = 1; batch <= 12; batch++) {
            if (batch % 3 === 0)
              yield* a.faults.inject(Fault.LoseResponse(), {
                match: creates(segmentKey(2, lease.head + 1n)),
              })
            const entry = `batch ${batch}`
            acknowledged.push([
              yield* a.store.append(lease, [text(entry), text(`${entry}'`)]),
              entry,
            ])
            if (batch === 4 || batch === 9)
              yield* a.store.checkpoint(lease, {
                offset: lease.head,
                statePages: [],
                indexPages: [],
                nextDue: batch,
              })
          }

          const recovered = yield* b.store.open(2)
          const newest = Option.getOrThrow(recovered.checkpoint)
          expect(newest.offset).toBe(acknowledged[8]?.[0])
          expect(newest.nextDue).toBe(9)
          const tail = yield* history(b.store, 2, newest.offset)
          expect(tail.map((segment) => [segment.offset, segment.entries[0] ?? "open"])).toEqual([
            ...acknowledged.slice(9),
            [recovered.open, "open"],
          ])
          const all = yield* history(b.store, 2, 0n)
          expect(all.map((segment) => segment.offset)).toEqual(
            Array.from({ length: all.length }, (_, index) => BigInt(index + 1)),
          )
          expect(all.flatMap((segment) => segment.entries)).toEqual(
            acknowledged.flatMap(([, entry]) => [entry, `${entry}'`]),
          )
        }),
    )

    it.effect(
      "trims only segments a checkpoint older than trimAfter covers (rejects trimming unchecked segments or trimming at once)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const lease = yield* a.store.open(3)
          for (let batch = 1; batch <= 9; batch++) yield* a.store.append(lease, [text(`${batch}`)])
          yield* a.store.checkpoint(lease, { offset: 6n, statePages: [], indexPages: [] })

          expect(yield* a.store.trim(lease, 10n)).toBe(0n)
          expect(yield* history(a.store, 3, 0n)).toHaveLength(10)
          yield* TestClock.adjust("9 minutes")
          expect(yield* a.store.trim(lease, 10n)).toBe(0n)
          yield* TestClock.adjust("1 minute")
          expect(yield* a.store.trim(lease, 10n)).toBe(6n)

          expect((yield* history(a.store, 3, 6n)).map((segment) => segment.offset)).toEqual([
            7n,
            8n,
            9n,
            10n,
          ])
          expect(yield* failureOf(history(a.store, 3, 0n))).toBeInstanceOf(CorruptSegment)
          const reopened = yield* b.store.open(3)
          expect(Option.map(reopened.checkpoint, (checkpoint) => checkpoint.offset)).toEqual(
            Option.some(6n),
          )
          expect(reopened.open).toBe(11n)
        }),
    )

    it.effect(
      "fences a stale owner whose next key was trimmed before it writes (rejects an owner that appends without re-checking after validFor)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const leaseA = yield* a.store.open(0)
          yield* a.store.append(leaseA, [text("a1")])
          const leaseB = yield* b.store.open(0)
          for (const entry of ["b1", "b2", "b3"]) yield* b.store.append(leaseB, [text(entry)])
          yield* b.store.checkpoint(leaseB, { offset: leaseB.head, statePages: [], indexPages: [] })
          yield* TestClock.adjust("10 minutes")
          expect(yield* b.store.trim(leaseB, leaseB.head)).toBe(6n)
          expect(yield* (yield* client).exists(segmentKey(0, 3n))).toBe(false)

          expect(yield* failureOf(a.store.append(leaseA, [text("late")]))).toBeInstanceOf(
            StaleEpoch,
          )
          expect((yield* a.faults.operations).filter(creates(segmentKey(0, 3n)))).toEqual([])
          expect(yield* (yield* client).exists(segmentKey(0, 3n))).toBe(false)
          expect(yield* history(b.store, 0, 6n)).toEqual([])
        }),
    )

    it.effect(
      "re-checks an owner idle past validFor and not one within it (rejects never re-checking, and re-checking on every append)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const lease = yield* a.store.open(1)
          const checks = Effect.map(
            a.faults.operations,
            (operations) => operations.filter((operation) => operation.kind === "exists").length,
          )
          yield* TestClock.adjust("9 seconds")
          yield* a.store.append(lease, [text("fresh")])
          yield* a.store.verify(lease)
          expect(yield* checks).toBe(0)

          yield* TestClock.adjust("11 seconds")
          yield* a.store.append(lease, [text("after a check")])
          expect(yield* checks).toBe(1)

          yield* b.store.open(1)
          yield* TestClock.adjust("11 seconds")
          expect(yield* failureOf(a.store.verify(lease))).toBeInstanceOf(StaleEpoch)
          expect(yield* checks).toBe(2)
        }),
    )

    it.effect(
      "stores pages once per content hash and checks them on load (rejects keys not derived from content and loads that trust stored bytes)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const raw = yield* client
          const alpha = yield* a.store.putPage(text("alpha"))
          expect(yield* a.store.putPage(text("alpha"))).toBe(alpha)
          const beta = yield* a.store.putPage(text("beta"))
          expect(beta).not.toBe(alpha)
          expect(yield* raw.list(PAGES_PREFIX)).toEqual([pageKey(alpha), pageKey(beta)].sort())
          expect(decoder.decode(yield* a.store.getPage(alpha))).toBe("alpha")
          expect(yield* failureOf(a.store.getPage("0".repeat(64)))).toBeInstanceOf(MissingPage)

          yield* raw.put(pageKey(beta), text("not beta"))
          expect(yield* failureOf(a.store.getPage(beta))).toBeInstanceOf(CorruptSegment)

          const many = Array.from({ length: 300 }, (_, index) => `page ${index}`)
          const hashes = yield* Effect.forEach(many, (body) => a.store.putPage(text(body)), {
            concurrency: 16,
          })
          const loaded = yield* Effect.forEach(hashes, (hash) => a.store.getPage(hash), {
            concurrency: "unbounded",
          })
          expect(loaded.map((bytes) => decoder.decode(bytes))).toEqual(many)
        }),
    )

    it.effect(
      "writes meta/store once for every concurrent creator (rejects a last-writer-wins identity record)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const stores = yield* Effect.forEach(
            [8, 32, 4],
            (shards) =>
              Effect.flatMap(client, (bucket) => storeOf(bucket, { shards, retry: RETRY })),
            { concurrency: "unbounded" },
          )
          const metas = stores.map((store) => store.meta)
          expect(new Set(metas.map((meta) => meta.store)).size).toBe(1)
          expect(new Set(metas.map((meta) => meta.shards)).size).toBe(1)
          const shards = metas[0]?.shards ?? 0
          const exit = yield* Effect.exit(stores[0]!.open(shards))
          expect(Exit.isFailure(exit) && !Exit.hasFails(exit)).toBe(true)
        }),
    )

    it.effect(
      "splits shards between live runners, moves a dead runner's shards and drops a paused runner's (rejects locks taken while their owner's heartbeat moves)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const b = yield* owner(client, "b")
          const storageA = yield* runnersOn(a.store)
          const storageB = yield* runnersOn(b.store)
          const addressA = RunnerAddress.make("runner-a", 34_001)
          const addressB = RunnerAddress.make("runner-b", 34_002)
          const machineA = yield* storageA.register(
            Runner.make({ address: addressA, groups: ["default"], weight: 1 }),
            true,
          )
          const machineB = yield* storageB.register(
            Runner.make({ address: addressB, groups: ["default"], weight: 1 }),
            true,
          )
          expect(machineA).not.toBe(machineB)

          expect(ids(yield* storageA.acquire(addressA, shardIds(0, 8)))).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7,
          ])
          expect(ids(yield* storageB.acquire(addressB, shardIds(8, 16)))).toEqual([
            8, 9, 10, 11, 12, 13, 14, 15,
          ])
          expect(yield* storageB.acquire(addressB, shardIds(0, 8))).toEqual([])
          expect(
            (yield* storageB.getRunners)
              .map(([runner]) => runner.address.port)
              .sort((left, right) => left - right),
          ).toEqual([34_001, 34_002])

          for (let step = 0; step < 4; step++) {
            yield* TestClock.adjust("10 seconds")
            expect(ids(yield* storageA.refresh(addressA, shardIds(0, 8)))).toEqual([
              0, 1, 2, 3, 4, 5, 6, 7,
            ])
            expect(ids(yield* storageB.refresh(addressB, shardIds(8, 16)))).toHaveLength(8)
            expect(yield* storageB.acquire(addressB, shardIds(0, 8))).toEqual([])
          }

          for (let step = 0; step < 4; step++) {
            yield* TestClock.adjust("10 seconds")
            yield* storageB.refresh(addressB, shardIds(8, 16))
            yield* storageB.getRunners
          }
          expect((yield* storageB.getRunners).map(([runner]) => runner.address.port)).toEqual([
            34_002,
          ])
          expect(ids(yield* storageB.acquire(addressB, shardIds(0, 4)))).toEqual([0, 1, 2, 3])

          expect(ids(yield* storageA.refresh(addressA, shardIds(0, 8)))).toEqual([4, 5, 6, 7])
          expect(yield* storageA.acquire(addressA, shardIds(0, 4))).toEqual([])
          yield* storageB.release(addressB, ShardId.make("default", 0))
          expect(ids(yield* storageA.acquire(addressA, shardIds(0, 1)))).toEqual([0])
        }),
    )

    it.effect(
      "passes its own conformance probe (rejects a backend whose conditional writes or listings are not atomic)",
      () =>
        Effect.gen(function* () {
          const client = yield* backend.namespace
          const a = yield* owner(client, "a")
          const report = yield* a.store.check({ writers: 8, rounds: 3, writes: 3 })
          expect(report.probes.filter((probe) => !probe.passed)).toEqual([])
          expect(report.passed).toBe(true)
          expect(yield* (yield* client).list("check/")).toEqual([])
        }),
    )
  })
