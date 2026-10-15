import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Option, Result, Scope, Stream } from "effect"
import { ActorError, ShardMoved } from "../../../../packages/akter/src/index.ts"
import { Entry, EntryCodec } from "../../../../packages/akter/src/execution/entries.ts"
import type { Engine } from "../../../../packages/akter/src/execution/engine.ts"
import { Recovery } from "../../../../packages/akter/src/snapshots/recovery.ts"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import { Fault, Faults } from "../../../../packages/akter/src/store/faults.ts"
import { checkpointKey, checkpointPrefix } from "../../../../packages/akter/src/store/keys.ts"
import type { Store } from "../../../../packages/akter/src/store/service.ts"
import { add, assignAll, mint, remind, runner, SHARDS, total } from "./engine-runner.ts"
import type { RunnerOptions } from "./engine-runner.ts"
import { spawnFixture } from "./platform.ts"

/** A fresh, empty store location: how to open a bucket client on it, and how a child process reaches it. */
export interface EngineLocation<E> {
  readonly bucket: Effect.Effect<Bucket, E, Scope.Scope>
  readonly env: Readonly<Record<string, string>>
}

/** A backend the engine scenarios run against. */
export interface EngineBackend<OpenError, ClientError> {
  readonly name: string
  readonly location: Effect.Effect<EngineLocation<ClientError>, OpenError, Scope.Scope>
}

const keys = ["k0", "k1", "k2", "k3", "k4", "k5"]

const shards = Array.from({ length: SHARDS }, (_, shard) => shard)

/** A runner in a scope of its own: `crash` closes it without a drain, as a dying process would. */
const started = <E>(location: EngineLocation<E>, options: RunnerOptions) =>
  Effect.gen(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    )
    const opened = yield* Scope.provide(scope)(
      Effect.flatMap(location.bucket, (bucket) => runner(bucket, options)),
    )
    return { ...opened, crash: Scope.close(scope, Exit.void) }
  })

/** Every entry of every shard, read through `store` from offset 0. */
const entriesOf = (store: Store["Service"]) =>
  Effect.map(
    Effect.forEach(shards, (shard) => Stream.runCollect(store.read(shard, 0n))),
    (logs) =>
      logs.flatMap((segments) =>
        Array.from(segments).flatMap((segment) =>
          segment.entries.map((bytes) => ({
            entry: Result.getOrThrow(EntryCodec.decode(bytes)),
          })),
        ),
      ),
  )

/** How many `Action` entries in the log carry each command id. */
const actionCounts = (store: Store["Service"]) =>
  Effect.map(entriesOf(store), (entries) => {
    const counts = new Map<string, number>()
    for (const { entry } of entries)
      if (Entry.guards.Action(entry))
        counts.set(entry.commandId, (counts.get(entry.commandId) ?? 0) + 1)
    return counts
  })

const totals = (engine: Engine) => Effect.forEach(keys, (key) => total(engine, key))

/** The fingerprint of every open shard of a runner. */
const fingerprints = (engine: Engine) =>
  shards.map((shard) => {
    const image = engine.durableImage(shard)
    return image === undefined ? "closed" : Recovery.fingerprint(image)
  })

const childScript = new URL("./engine-child.ts", import.meta.url)

/**
 * Runs an owner process against the location until it has acknowledged `acks` calls, then kills
 * it with SIGKILL. Returns the ids it sent, in order, and the replies it acknowledged. The child
 * keeps sending until the signal lands, and prints each id before sending it, so its output is
 * read to the end after the kill: an id it sent after the parent decided to kill it may be durable.
 */
const killedOwner = (env: Readonly<Record<string, string>>, acks: number) =>
  Effect.gen(function* () {
    const child = yield* spawnFixture(childScript, env)
    const sent: Array<string> = []
    const acked = new Map<number, number>()
    let signal: string | null | undefined
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const [kind, call, rest] = line.split(" ", 3)
          if (kind === "sent" && rest !== undefined) sent[Number(call)] = rest
          if (kind === "ack" && rest !== undefined) acked.set(Number(call), Number(rest))
          if (signal === undefined && acked.size >= acks) signal = (yield* child.kill).signal
        }),
      ),
    )
    expect(signal).toBe("SIGKILL")
    expect(acked.size).toBeGreaterThanOrEqual(acks)
    return { sent, acked }
  })

/**
 * The engine's recovery, drain, replay and fault scenarios on one real backend. Each runner is its
 * own store instance and engine over the shared location, so a crash loses its memory and nothing
 * else; time is the real clock. Each scenario names the wrong implementation it rejects.
 */
export const engineConformance = <OpenError, ClientError>(
  backend: EngineBackend<OpenError, ClientError>,
) =>
  describe(`Engine on ${backend.name}`, () => {
    it.live(
      "recovers a crashed owner's acknowledged actions and timers on the next owner and answers a retried id from the log (rejects recovery that loses an acknowledged write, runs a retried id again or drops a timer)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const a = yield* started(location, { writer: "a" })
          yield* assignAll(a.engine)
          const ids = yield* Effect.forEach(keys, () => mint)
          const replies = yield* Effect.forEach(keys, (key, index) =>
            add(a.engine, ids[index] ?? "", key, index + 1),
          )
          expect(replies).toEqual(keys.map((_, index) => ({ kind: "Success", value: index + 1 })))
          yield* remind(a.engine, "k0", 100)
          const before = fingerprints(a.engine)
          yield* a.crash

          const b = yield* started(location, { writer: "b" })
          yield* assignAll(b.engine)
          expect(fingerprints(b.engine)).toEqual(before)
          expect(yield* totals(b.engine)).toEqual([1, 2, 3, 4, 5, 6])
          expect(yield* add(b.engine, ids[2] ?? "", "k2", 3)).toEqual({ kind: "Success", value: 3 })
          yield* Effect.sleep(Duration.seconds(2))
          expect(yield* total(b.engine, "k0")).toBe(101)
          const counts = yield* actionCounts(b.store)
          expect(ids.map((id) => counts.get(id))).toEqual(keys.map(() => 1))
        }),
      60_000,
    )

    it.live(
      "drains under load: what was admitted becomes durable, each log ends in Released after a checkpoint, refused calls land once on the next owner, and it replays no action (rejects a drain that drops admitted actions or leaves a tail to replay)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const a = yield* started(location, { writer: "a" })
          yield* assignAll(a.engine)
          const ids = yield* Effect.forEach(Array.from({ length: 24 }), () => mint)
          const calls = yield* Effect.forkChild(
            Effect.forEach(
              ids,
              (id, index) => Effect.exit(add(a.engine, id, keys[index % 6] ?? "k0", 1)),
              { concurrency: "unbounded" },
            ),
          )
          yield* Effect.sleep(Duration.millis(5))
          const report = yield* a.engine.drain("20 seconds")
          expect(report.outcome).toBe("clean")
          const outcomes = yield* Fiber.join(calls)
          for (const outcome of outcomes)
            if (Exit.isFailure(outcome))
              expect(Exit.findErrorOption(outcome)).toEqual(
                Option.some(ActorError.make({ reason: ShardMoved.make({}) })),
              )

          const b = yield* started(location, { writer: "b" })
          yield* assignAll(b.engine)
          for (const shard of shards) {
            const lease = b.engine.lease(shard)
            const checkpoint = Option.getOrUndefined(lease?.checkpoint ?? Option.none())
            const drained = report.shards.find((entry) => entry.shard === shard)
            expect(checkpoint?.offset).toBe(BigInt((drained?.offset ?? 0) - 1))
            const tail = yield* Stream.runCollect(b.store.read(shard, checkpoint?.offset ?? 0n))
            const tags = Array.from(tail).flatMap((segment) =>
              segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))._tag),
            )
            expect(tags).toEqual(["Released"])
          }
          yield* Effect.forEach(ids, (id, index) => add(b.engine, id, keys[index % 6] ?? "k0", 1))
          expect(yield* totals(b.engine)).toEqual([4, 4, 4, 4, 4, 4])
          const counts = yield* actionCounts(b.store)
          expect(ids.map((id) => counts.get(id))).toEqual(ids.map(() => 1))
        }),
      60_000,
    )

    it.live(
      "replays a tail only on the build that wrote it: the new build refuses it, a runner of the old build replays and drains it, and then the new build opens (rejects replaying another build's actions with new code, and refusing a drained log)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const v1 = yield* started(location, { writer: "a", bundle: "v1", checkpointEvery: 0 })
          yield* assignAll(v1.engine)
          yield* Effect.forEach(keys, (key, index) =>
            Effect.flatMap(mint, (id) => add(v1.engine, id, key, index + 1)),
          )
          const before = fingerprints(v1.engine)
          yield* v1.crash

          const v2 = yield* started(location, { writer: "b", bundle: "v2" })
          yield* assignAll(v2.engine)
          expect(shards.map((shard) => v2.engine.status(shard).status)).toEqual(
            shards.map(() => "refused"),
          )

          const old = yield* started(location, { writer: "c", bundle: "v1" })
          yield* assignAll(old.engine)
          expect(fingerprints(old.engine)).toEqual(before)
          expect((yield* old.engine.drain("20 seconds")).outcome).toBe("clean")

          yield* assignAll(v2.engine)
          expect(fingerprints(v2.engine)).toEqual(before)
          expect(yield* totals(v2.engine)).toEqual([1, 2, 3, 4, 5, 6])
        }),
      60_000,
    )

    it.live(
      "answers a call whose segment write lost its response once, from the segment's own header (rejects retrying at the next offset, or failing a write that landed)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const faults = Faults.plan()
          const a = yield* started(location, { writer: "a", faults })
          yield* assignAll(a.engine)
          const lost = yield* faults.inject(Fault.LoseResponse(), {
            match: (operation) => operation.kind === "create" && operation.key.includes("/log/"),
          })
          const id = yield* mint
          expect(yield* add(a.engine, id, "k1", 7)).toEqual({ kind: "Success", value: 7 })
          yield* lost.fired
          expect(yield* add(a.engine, yield* mint, "k1", 1)).toEqual({ kind: "Success", value: 8 })
          const counts = yield* actionCounts(a.store)
          expect(counts.get(id)).toBe(1)
          yield* a.crash
          const b = yield* started(location, { writer: "b" })
          yield* assignAll(b.engine)
          expect(yield* total(b.engine, "k1")).toBe(8)
        }),
      60_000,
    )

    it.live(
      "keeps the previous checkpoint in charge when a crash lands between its page and its manifest, and the next owner recovers the same state (rejects recovering from pages without a manifest, and losing the tail after the last good checkpoint)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const faults = Faults.plan()
          const a = yield* started(location, { writer: "a", faults, checkpointEvery: 1 })
          yield* assignAll(a.engine)
          yield* Effect.forEach(keys, (key, index) =>
            Effect.flatMap(mint, (id) => add(a.engine, id, key, index + 1)),
          )
          const shard = a.engine.shardOf('Tally/"k2"')
          const bucket = yield* location.bucket
          const offset = BigInt(a.engine.durableImage(shard)?.offset ?? 0)
          const previous = checkpointKey(shard, offset)
          for (let poll = 0; ; poll++) {
            if ((yield* bucket.list(checkpointPrefix(shard)))[0] === previous) break
            if (poll === 2_000) return yield* Effect.die(new Error("no initial checkpoint"))
            yield* Effect.sleep("10 millis")
          }
          const manifests = yield* faults.inject(Fault.Hold(), {
            match: (operation) =>
              operation.kind === "create" && operation.key.startsWith(checkpointPrefix(shard)),
          })
          yield* add(a.engine, yield* mint, "k2", 10)
          yield* manifests.fired
          const before = fingerprints(a.engine)
          yield* a.crash

          const b = yield* started(location, { writer: "b" })
          yield* assignAll(b.engine)
          expect(fingerprints(b.engine)).toEqual(before)
          expect(yield* totals(b.engine)).toEqual([1, 2, 13, 4, 5, 6])
          expect(
            Option.getOrUndefined(b.engine.lease(shard)?.checkpoint ?? Option.none())?.offset,
          ).toBe(offset)
          expect((yield* bucket.list(checkpointPrefix(shard)))[0]).toBe(previous)
        }),
      60_000,
    )

    it.live(
      "loses nothing a SIGKILLed owner process acknowledged, and applies every id it sent once when retried (rejects acknowledging before the segment is durable, and running a durable id again)",
      () =>
        Effect.gen(function* () {
          const location = yield* backend.location
          const { sent, acked } = yield* killedOwner(location.env, 12)
          const b = yield* started(location, { writer: "b" })
          yield* assignAll(b.engine)
          const replies = yield* Effect.forEach(sent, (id, call) =>
            add(b.engine, id, `k${call % 4}`, call + 1),
          )
          for (const [call, value] of acked)
            expect(replies[call]).toEqual({ kind: "Success", value })
          const expected = [0, 1, 2, 3].map((key) =>
            sent.reduce((sum, _, call) => (call % 4 === key ? sum + call + 1 : sum), 0),
          )
          expect(yield* Effect.forEach([0, 1, 2, 3], (key) => total(b.engine, `k${key}`))).toEqual(
            expected,
          )
          const counts = yield* actionCounts(b.store)
          expect(sent.map((id) => counts.get(id))).toEqual(sent.map(() => 1))
        }),
      60_000,
    )
  })
