import { Clock, Effect, Fiber, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Actor, user } from "../index.ts"
import { Durable } from "../execution/durable.ts"
import { Entry, EntryCodec, Origin } from "../execution/entries.ts"
import { Simulation, SimulationService } from "./simulation.ts"

const Mail = Actor.make("Mail", {
  state: Schema.Struct({
    total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    received: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    send: Actor.action(Schema.Struct({ to: Schema.String, amount: Schema.Int })),
    receive: Actor.action(Schema.Int, { internal: true }),
    remind: Actor.action(Schema.Int),
    later: Actor.action(Schema.Int),
  },
})

const MailLive = Mail.toLayer({
  send: (_, { to, amount }, { send }) => {
    send(Mail, to).receive(amount)
  },
  receive: (mail, amount) => {
    mail.total += amount
    mail.received++
  },
  remind: (_, amount, { schedule }) => {
    schedule("1 second").receive(amount)
  },
  later: (_, amount, { schedule }) => {
    schedule("20 seconds").receive(amount)
  },
})

const keyFor = (shard: number): string => {
  for (let candidate = 0; ; candidate++) {
    const key = `mail-${candidate}`
    if (Durable.shardOf(Durable.addressOf(Mail.name, key), 4) === shard) return key
  }
}

const sender = keyFor(0)
const receiver = keyFor(1)

const run = (seed: number) =>
  Simulation.run(
    {
      actors: [Mail],
      seed,
      shards: 4,
      runners: [{}, {}],
      assignments: [0, 1, 0, 1],
      faults: ["crash", "lostResponse", "unavailable", "slowLog"],
    },
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Mail.client(sender)
        const simulator = yield* SimulationService
        const moving = yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Effect.sleep("2 millis")
            yield* Simulation.partition(1, "40 millis")
            yield* Simulation.assignShards(1, [0])
            yield* Effect.sleep("5 millis")
            yield* Simulation.assignShards(0, [1])
          }),
        )
        yield* handle.send({ to: receiver, amount: 7 })
        yield* handle.send({ to: receiver, amount: 19 })
        yield* handle.remind(31)
        yield* simulator.waiting(Fiber.join(moving))
        yield* Simulation.settle
        expect(yield* Simulation.state(Mail, receiver)).toEqual({ total: 26, received: 2 })
        expect(yield* Simulation.state(Mail, sender)).toEqual({ total: 31, received: 1 })
        const logs = yield* simulator.logs
        return logs.map((log) => ({
          shard: log.shard,
          segments: log.segments.map((segment) => ({
            offset: segment.offset.toString(),
            open: segment.open.toString(),
            writer: segment.writer,
            entries: segment.entries.map((bytes) => Array.from(bytes)),
          })),
        }))
      }),
    ),
    MailLive,
  )

describe("partitioned multi-runner simulator", () => {
  it("F14 rejects interruption between marking a shard opening and forking its recovery; seed 1007681566 must not strand its timer", () =>
    run(1_007_681_566))
  it("F14 rejects leaving a due timer armed forever when an expired lease's verification is temporarily unavailable", () =>
    Simulation.run(
      { actors: [Mail], seed: 14, shards: 4 },
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* Mail.client(sender)
          yield* handle.later(53)
          yield* Simulation.partition(0, "21 seconds")
          yield* Simulation.advance("22 seconds")
          expect(yield* Simulation.state(Mail, sender)).toEqual({ total: 53, received: 1 })
        }),
      ),
      MailLive,
    ))
  it(
    "F13/F14 rejects local-only delivery, expired receiver watermarks and timer duplication across 1,000 faulted split-shard seeds",
    () =>
      Effect.runPromise(
        Effect.forEach(
          Array.from({ length: 1_000 }, (_, index) => index + 1),
          (seed) => Effect.promise(() => run(0x3c10_0000 + seed)),
          { discard: true },
        ),
      ),
    120_000,
  )

  it(
    "I3/I9 exactly replays 50 split-shard seeds byte-for-byte through owner moves, partitions and retries",
    () =>
      Effect.runPromise(
        Effect.forEach(
          Array.from({ length: 50 }, (_, index) => index + 1),
          (seed) =>
            Effect.gen(function* () {
              const first = yield* Effect.promise(() => run(0x3c10_0000 + seed))
              const second = yield* Effect.promise(() => run(0x3c10_0000 + seed))
              expect(first, `seed ${seed}`).toEqual(second)
            }),
          { discard: true },
        ),
      ),
    30_000,
  )

  it("F27 rejects dropping a timer due with no runner; nextDue survives the checkpoint and it fires once on restart", () =>
    Simulation.run(
      { actors: [Mail], seed: 27, shards: 4, runners: [{}, {}], caller: user("dora") },
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* Mail.client(sender)
          yield* handle.remind(43)
          const before = yield* Clock.currentTimeMillis
          const report = yield* Simulation.drain()
          expect(report.outcome).toBe("clean")
          expect(report.shards.find((shard) => shard.shard === 0)?.nextDue).toBeGreaterThan(before)
          yield* TestClock.adjust("2 seconds")
          yield* Simulation.assign(1)
          yield* Simulation.settle
          expect(yield* Simulation.state(Mail, sender)).toEqual({ total: 43, received: 1 })
          yield* Simulation.crash(Mail, sender)
          yield* Simulation.settle
          expect(yield* Simulation.state(Mail, sender)).toEqual({ total: 43, received: 1 })
          const simulator = yield* SimulationService
          const log = (yield* simulator.logs)[0]!
          const actions = log.segments
            .flatMap((segment) => segment.entries)
            .map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes)))
            .filter(Entry.guards.Action)
          const fired = actions.filter((action) => Origin.guards.Fired(action.origin))
          expect(fired).toHaveLength(1)
          expect(fired[0]?.caller).toHaveProperty("_tag", "System")
          expect(fired[0]?.caller).toMatchObject({
            source: "timer",
            onBehalfOf: "dora",
          })
        }),
      ),
      MailLive,
    ))
})
