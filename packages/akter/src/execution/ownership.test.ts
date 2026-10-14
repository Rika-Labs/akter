import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Exit, Fiber, Option, Result, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { Actor, ActorError, ActorUnavailable, ShardMoved, user } from "../index.ts"
import type { Client } from "../contract/handle.ts"
import { Recovery } from "../snapshots/recovery.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import type { SimulationOptions } from "../testing/index.ts"
import { CommandIds } from "./command-ids.ts"
import { Durable } from "./durable.ts"
import { Entry, EntryCodec } from "./entries.ts"
import type { Status } from "./engine.ts"
import { Transports } from "./transport.ts"
import { PageDocuments } from "../handlers/page-tree.ts"

const Account = Actor.make("Account", {
  state: Schema.Struct({
    balance: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    credits: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    ticks: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    deposit: Actor.action(Schema.Finite, { success: Schema.Finite }),
    transfer: Actor.action(Schema.Struct({ to: Schema.String, amount: Schema.Finite }), {
      success: Schema.Finite,
    }),
    remind: Actor.action(Schema.Finite),
    credit: Actor.action(Schema.Finite, { internal: true }),
    tick: Actor.action({ cron: "0 0 * * *" }),
  },
  events: { changed: Actor.event(Schema.Finite) },
})

const AccountLive = Account.toLayer({
  deposit: (account, amount, { emit }) => {
    account.balance += amount
    emit.changed(account.balance)
    return account.balance
  },
  transfer: (account, { to, amount }, { send, emit }) => {
    account.balance -= amount
    send(Account, to).credit(amount)
    emit.changed(account.balance)
    return account.balance
  },
  remind: (_, amount, { schedule }) => {
    schedule("1 hour").credit(amount)
  },
  credit: (account, amount) => {
    account.balance += amount
    account.credits += 1
  },
  tick: (account) => {
    account.ticks += 1
  },
})

type AccountOptions = Omit<SimulationOptions<ReadonlyArray<typeof Account>>, "actors">

const simulate = <A, E>(
  options: AccountOptions,
  program: Effect.Effect<A, E, SimulationService | Client | TestClock.TestClock | Scope.Scope>,
) => Simulation.run({ actors: [Account], ...options }, Effect.scoped(program), AccountLive)

const ana = user("ana")

const moved = ActorError.make({ reason: ShardMoved.make({}) })
const unavailable = ActorError.make({ reason: ActorUnavailable.make({}) })

const mint = Effect.flatMap(Clock.currentTimeMillis, CommandIds.mint)

const shardOf = (key: string) =>
  Effect.map(SimulationService, (simulator) =>
    simulator.engine.shardOf(Durable.addressOf("Account", key)),
  )

/** Every entry of one shard's log, in order, with the offset and writer of its segment. */
const logOf = (shard: number) =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const logs = yield* simulator.logs
    return (logs[shard]?.segments ?? []).flatMap((segment) =>
      segment.entries.map((bytes) => ({
        offset: Number(segment.offset),
        writer: segment.writer,
        entry: Result.getOrThrow(EntryCodec.decode(bytes)),
      })),
    )
  })

/** The action entries one account's member has in the log, with the writer that made each durable. */
const actionsOf = (key: string, member: string) =>
  Effect.gen(function* () {
    const log = yield* logOf(yield* shardOf(key))
    return log.flatMap(({ entry, writer }) =>
      Entry.guards.Action(entry) && entry.key === key && entry.member === member
        ? [{ entry, writer }]
        : [],
    )
  })

/** One client attempt at a deposit, with a fixed command id, reaching one runner's engine. */
const depositOn = (runner: number, commandId: string, key: string, amount: number) =>
  Effect.flatMap(SimulationService, (simulator) => {
    const engine = simulator.runners[runner]?.engine
    return engine === undefined
      ? Effect.die(new RangeError(`there is no runner ${runner}`))
      : Transports.admit(engine, ana, commandId, {
          actor: Account,
          id: key,
          member: "deposit",
          payload: amount,
        })
  })

/** {@link depositOn} retried with the same id while the answer is retryable, as a client does. */
const retriedOn = (runner: number, commandId: string, key: string, amount: number) =>
  Effect.flatMap(SimulationService, (simulator) =>
    simulator.waiting(
      Transports.retryWhileUnavailable(
        Effect.provideService(
          depositOn(runner, commandId, key, amount),
          SimulationService,
          simulator,
        ),
      ),
    ),
  )

/** Yields to the scheduler until `check` holds, so the step under test has happened. */
const until = (what: string, check: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 10_000; turn++) {
      if (check()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error(`never ${what}`))
  })

const statusOf = (runner: number, shard: number) =>
  Effect.map(
    SimulationService,
    (simulator): Status | undefined => simulator.runners[runner]?.engine.status(shard).status,
  )

const untilStatus = (runner: number, shard: number, status: Status) =>
  Effect.flatMap(SimulationService, (simulator) =>
    until(
      `runner ${runner} has shard ${shard} ${status}`,
      () => simulator.runners[runner]?.engine.status(shard).status === status,
    ),
  )

const untilInFlight = (runner: number) =>
  Effect.flatMap(SimulationService, (simulator) =>
    until(`runner ${runner} has an append in flight`, () =>
      Option.exists(
        Option.fromNullishOr(simulator.runners[runner]?.engine.busy(Number.NEGATIVE_INFINITY)),
        (busy) => busy.includes("in flight"),
      ),
    ),
  )

describe("F6: a crash after the append is durable and before the reply", () => {
  it("answers the retried id from the log: the transfer ran once, its send is delivered once by the next owner, and its event is never replayed", () =>
    simulate(
      { seed: 71, shards: 1 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* Simulation.settle
        const a = yield* Account.client("a")
        const events: Array<number> = []
        yield* Effect.forkChild(
          Stream.runForEach(a.changed, (value) => Effect.sync(() => events.push(value))),
        )
        yield* Effect.yieldNow
        simulator.bucket.script({
          runner: 0,
          fault: "crashAfter",
          match: (operation, key) => operation === "create" && key.startsWith("s/00/log/"),
        })
        const commandId = yield* mint
        const transfer = Transports.admit(simulator.engine, ana, commandId, {
          actor: Account,
          id: "a",
          member: "transfer",
          payload: { to: "b", amount: 10 },
        })
        expect(yield* Effect.flip(transfer)).toEqual(unavailable)
        expect(simulator.bucket.counts().crashes).toBe(1)
        yield* Simulation.settle
        expect(yield* transfer).toEqual({ kind: "Success", value: 90 })
        yield* Simulation.settle
        const [after, b] = yield* Effect.all([
          Simulation.state(Account, "a"),
          Simulation.state(Account, "b"),
        ])
        expect([after.balance, b.balance, b.credits]).toEqual([90, 10, 1])
        expect((yield* actionsOf("a", "transfer")).length).toBe(1)
        expect((yield* actionsOf("b", "credit")).length).toBe(1)
        expect(events).toEqual([])
      }),
    ))
})

describe("F7: an append with a stale epoch after the shard moved", () => {
  it("the old owner's late append finds the next segment taken: it publishes nothing, answers ShardMoved and stays fenced until the runner layer assigns the shard back; the retry runs once on the new owner", () =>
    simulate(
      { seed: 72, shards: 1, runners: [{}, {}] },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const old = simulator.runners[0]
        if (old === undefined) return yield* Effect.die(new Error("no runner 0"))
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* Simulation.settle
        const commandId = yield* mint
        yield* Simulation.pause(0, "5 seconds")
        const stale = yield* Effect.forkChild(depositOn(0, commandId, "a", 5))
        yield* untilInFlight(0)
        yield* Simulation.assign(1)
        yield* untilStatus(1, 0, "open")
        yield* TestClock.adjust("5 seconds")
        expect(yield* Effect.flip(Fiber.join(stale))).toEqual(moved)
        expect(yield* statusOf(0, 0)).toBe("fenced")
        expect(yield* Effect.flip(depositOn(0, commandId, "a", 5))).toEqual(moved)
        expect(yield* Effect.flip(old.engine.durableRecord(Account, "a"))).toEqual(moved)
        expect(yield* statusOf(0, 0)).toBe("fenced")
        expect(yield* depositOn(1, commandId, "a", 5)).toEqual({ kind: "Success", value: 105 })
        expect(yield* depositOn(1, commandId, "a", 5)).toEqual({ kind: "Success", value: 105 })
        yield* Simulation.settle
        expect((yield* actionsOf("a", "deposit")).map(({ writer }) => writer)).toEqual([
          "simulation-1",
        ])

        yield* Simulation.assign(0)
        yield* untilStatus(0, 0, "open")
        const a = yield* Account.client("a")
        expect(yield* a.deposit(1)).toBe(106)
        yield* Simulation.settle
        expect((yield* actionsOf("a", "deposit")).map(({ writer }) => writer)).toEqual([
          "simulation-1",
          "simulation",
        ])
      }),
    ))
})

describe("F8: two runners believe they own a shard", () => {
  it("only the newest epoch appends; the cut-off owner answers reads from memory only within validFor and never makes a write durable; every call applies once", () =>
    simulate(
      { seed: 73, shards: 1, runners: [{}, {}] },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const old = simulator.runners[0]
        if (old === undefined) return yield* Effect.die(new Error("no runner 0"))
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* Simulation.settle
        yield* Simulation.partition(0, "40 seconds")
        yield* Simulation.assign(1)
        yield* untilStatus(1, 0, "open")
        expect(yield* statusOf(0, 0)).toBe("open")
        expect(yield* depositOn(1, yield* mint, "a", 7)).toEqual({ kind: "Success", value: 107 })
        expect((yield* old.engine.durableRecord(Account, "a")).image.state).toMatchObject({
          balance: 100,
        })

        yield* TestClock.adjust("11 seconds")
        const read = yield* Effect.exit(simulator.waiting(old.engine.durableRecord(Account, "a")))
        expect(Exit.isFailure(read)).toBe(true)
        const written = yield* mint
        const refused = yield* Effect.flip(simulator.waiting(depositOn(0, written, "a", 5)))
        expect([unavailable, moved]).toContainEqual(refused)
        yield* Simulation.settle
        expect(yield* retriedOn(1, written, "a", 5)).toEqual({ kind: "Success", value: 112 })
        yield* Simulation.settle
        expect((yield* actionsOf("a", "deposit")).map(({ writer }) => writer)).toEqual([
          "simulation-1",
          "simulation-1",
        ])
        expect((yield* Simulation.state(Account, "a")).balance).toBe(112)
      }),
    ))
})

describe("F9: a crash while checkpointing", () => {
  const checkpointed = (fault: "page" | "pointer", seed: number) =>
    simulate(
      { seed, shards: 1, checkpointEvery: 2 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const a = yield* Account.client("a")
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* a.deposit(1)
        yield* Simulation.settle
        const [before] = yield* simulator.logs
        const previousPages = yield* simulator.bucket.inspect.list("pages/")
        const pages = previousPages.length
        simulator.bucket.script({
          runner: 0,
          fault: "crashBefore",
          shard: 0,
          match: (_, key) =>
            fault === "page" ? key.startsWith("pages/") : key.startsWith("s/00/cp/"),
        })
        let balance = 101
        for (const amount of [2, 3, 4]) {
          if (simulator.bucket.counts().crashes > 0) break
          balance += amount
          expect(yield* a.deposit(amount)).toBe(balance)
        }
        yield* Simulation.settle
        expect(simulator.bucket.counts().crashes).toBe(1)
        const [after] = yield* simulator.logs
        if (before === undefined || after === undefined) return yield* Effect.die(new Error("log"))
        expect(after.checkpoints.at(-1)?.offset).toBe(before.checkpoints.at(-1)?.offset)
        expect((yield* simulator.bucket.inspect.list("pages/")).length).toBe(
          fault === "page" ? pages : pages + 2,
        )
        if (fault === "pointer") {
          const orphanKeys = (yield* simulator.bucket.inspect.list("pages/")).filter(
            (key) => !previousPages.includes(key),
          )
          const orphans = yield* Effect.forEach(orphanKeys, (key) =>
            Effect.map(
              simulator.engine.store.getPage(key.slice("pages/".length)),
              PageDocuments.decode,
            ),
          )
          expect(orphans.map((page) => page.kind).sort()).toEqual(["actor", "checkpoint"])
          const root = orphans.find((page) => page.kind === "checkpoint")!
          const actor = orphanKeys[orphans.findIndex((page) => page.kind === "actor")]!
          expect(root.references).toEqual([actor.slice("pages/".length)])
        }
        const replayed = Recovery.recover(
          simulator.catalog,
          0,
          undefined,
          after.segments,
          simulator.build,
          "matching",
        )
        const live = simulator.engine.durableImage(0)
        if (Result.isFailure(replayed) || live === undefined)
          return yield* Effect.die(new Error("the shard did not recover"))
        expect(Recovery.fingerprint(live)).toBe(Recovery.fingerprint(replayed.success))
        expect((yield* Simulation.state(Account, "a")).balance).toBe(balance)
      }),
    )

  it("during the page upload: no checkpoint is recorded, and the owner recovers from the previous one and the longer tail to the state a full replay gives", () =>
    checkpointed("page", 74))

  it("between the page and the checkpoint: the page is orphaned, the checkpoint still names the previous one, and recovery gives the same state", () =>
    checkpointed("pointer", 75))
})

describe("F10: the bucket unavailable or slow", () => {
  it("while the bucket is unreachable the owner answers ActorUnavailable, never a storage error, and publishes nothing; the retried id applies once after it returns", () =>
    simulate(
      { seed: 76, shards: 1 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* Simulation.settle
        const a = yield* Account.client("a")
        const events: Array<number> = []
        yield* Effect.forkChild(
          Stream.runForEach(a.changed, (value) => Effect.sync(() => events.push(value))),
        )
        yield* Effect.yieldNow
        const started = yield* Clock.currentTimeMillis
        yield* Simulation.partition(0, "20 seconds")
        const commandId = yield* mint
        expect(yield* Effect.flip(simulator.waiting(depositOn(0, commandId, "a", 5)))).toEqual(
          unavailable,
        )
        expect(events).toEqual([])
        expect(yield* retriedOn(0, commandId, "a", 5)).toEqual({ kind: "Success", value: 105 })
        expect((yield* Clock.currentTimeMillis) - started).toBeGreaterThanOrEqual(20_000)
        yield* Simulation.settle
        expect(events).toEqual([105])
        expect((yield* actionsOf("a", "deposit")).length).toBe(1)
      }),
    ))

  it("a slow bucket holds the reply until the segment is durable and shows nothing before it", () =>
    simulate(
      { seed: 77, shards: 1 },
      Effect.gen(function* () {
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* Simulation.settle
        const a = yield* Account.client("a")
        const events: Array<number> = []
        yield* Effect.forkChild(
          Stream.runForEach(a.changed, (value) => Effect.sync(() => events.push(value))),
        )
        yield* Effect.yieldNow
        const started = yield* Clock.currentTimeMillis
        yield* Simulation.pause(0, "3 seconds")
        const call = yield* Effect.forkChild(a.deposit(5))
        yield* untilInFlight(0)
        expect(call.pollUnsafe()).toBeUndefined()
        expect([(yield* Simulation.state(Account, "a")).balance, events]).toEqual([100, []])
        yield* Simulation.settle
        expect(yield* Fiber.join(call)).toBe(105)
        expect((yield* Clock.currentTimeMillis) - started).toBeGreaterThanOrEqual(3_000)
        expect(events).toEqual([105])
      }),
    ))
})

const keys = ["a", "b", "c", "d", "e"]

describe("F11: a graceful drain during load", () => {
  it("makes everything admitted durable, checkpoints it, ends each log with Released and reports where; callers retry on the next owner and each transfer applies once", () =>
    simulate(
      { seed: 78, shards: 4, runners: [{}, {}] },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        yield* Effect.forEach(keys, (key) => Simulation.seed(Account, key, { balance: 100 }))
        yield* Simulation.settle
        const a = yield* Account.client("a")
        const remindedAt = yield* Clock.currentTimeMillis
        yield* a.remind(0)
        const calls = yield* Effect.forkChild(
          Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) =>
              Effect.flatMap(Account.client(keys[index % 5] ?? "a"), (account) =>
                account.transfer({ to: keys[(index * 3 + 1) % 5] ?? "b", amount: 1 + index }),
              ),
            { concurrency: "unbounded" },
          ),
        )
        yield* until("a transfer is in flight", () =>
          simulator.publications.some(
            ({ entry }) => Entry.guards.Action(entry) && entry.member === "transfer",
          ),
        )
        const published = () =>
          simulator.publications.filter(
            ({ entry }) => Entry.guards.Action(entry) && entry.member === "transfer",
          ).length
        const atDrain = published()
        expect(atDrain).toBeLessThan(20)
        const report = yield* Simulation.drain("30 seconds")
        expect(report.outcome).toBe("clean")
        const logs = yield* simulator.logs
        const shardsOf = yield* Effect.forEach(keys, shardOf)
        expect(report.shards.map(({ shard }) => shard)).toEqual([0, 1, 2, 3])
        for (const drained of report.shards) {
          const log = logs[drained.shard]
          const last = log?.segments.at(-1)
          expect(
            last?.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))._tag),
          ).toEqual(["Released"])
          expect(drained.offset).toBe(Number(last?.offset))
          expect(log?.checkpoints.at(-1)?.offset).toBe(drained.offset - 1)
          const holds = keys.filter((_, index) => shardsOf[index] === drained.shard)
          expect(drained.nextDue).toBe(
            holds.includes("a") ? remindedAt + 3_600_000 : holds.length > 0 ? 86_400_000 : null,
          )
        }
        yield* Simulation.assign(1)
        const replies = yield* Fiber.join(calls)
        yield* Simulation.settle
        expect(replies.length).toBe(20)
        const states = yield* Effect.forEach(keys, (key) => Simulation.state(Account, key))
        expect(states.reduce((sum, state) => sum + state.balance, 0)).toBe(500)
        expect(states.reduce((sum, state) => sum + state.credits, 0)).toBe(21)
        expect(published()).toBe(20)
        const transfers = yield* Effect.forEach(keys, (key) => actionsOf(key, "transfer"))
        expect(transfers.flat().length).toBe(20)
      }),
    ))

  it("a drain that outlives its deadline closes the shard without publishing what was not durable and reports timedOut; the retry applies once on the next owner", () =>
    simulate(
      { seed: 79, shards: 1, runners: [{}, {}] },
      Effect.gen(function* () {
        yield* Simulation.seed(Account, "a", { balance: 100 })
        yield* Simulation.settle
        const [before] = (yield* logOf(0)).slice(-1)
        const a = yield* Account.client("a")
        yield* Simulation.pause(0, "1 minute")
        const call = yield* Effect.forkChild(a.deposit(5))
        yield* untilInFlight(0)
        const report = yield* Simulation.drain("5 seconds")
        expect(report.outcome).toBe("timedOut")
        expect(report.shards.map(({ offset }) => offset)).toEqual([before?.offset])
        expect(yield* statusOf(0, 0)).toBe("closed")
        yield* Simulation.assign(1)
        expect(yield* Fiber.join(call)).toBe(105)
        yield* Simulation.advance("2 minutes")
        expect((yield* actionsOf("a", "deposit")).map(({ writer }) => writer)).toEqual([
          "simulation-1",
        ])
      }),
    ))
})

describe("F12: a tail written by another build", () => {
  const tailFromV1 = Effect.gen(function* () {
    const simulator = yield* SimulationService
    yield* Simulation.seed(Account, "a", { balance: 100 })
    const a = yield* Account.client("a")
    yield* a.transfer({ to: "b", amount: 10 })
    yield* a.remind(3)
    yield* Simulation.settle
    const image = simulator.engine.durableImage(0)
    if (image === undefined) return yield* Effect.die(new Error("the shard is closed"))
    const expected = Recovery.fingerprint(image)
    yield* Simulation.partition(0, "30 days")
    yield* Simulation.assign(1)
    yield* untilStatus(1, 0, "refused")
    return expected
  })

  const fingerprintOn = (runner: number) =>
    Effect.flatMap(SimulationService, (simulator) => {
      const image = simulator.runners[runner]?.engine.durableImage(0)
      return image === undefined
        ? Effect.die(new Error(`runner ${runner} has the shard closed`))
        : Effect.succeed(Recovery.fingerprint(image))
    })

  it("is refused by the new build; a runner of the old build replays it and drains, and then the new build opens with nothing to replay", () =>
    simulate(
      {
        seed: 80,
        shards: 1,
        checkpointEvery: 0,
        runners: [{ bundle: "v1" }, { bundle: "v2" }, { bundle: "v1" }],
      },
      Effect.gen(function* () {
        const expected = yield* tailFromV1
        yield* Simulation.assign(2)
        yield* untilStatus(2, 0, "open")
        expect(yield* fingerprintOn(2)).toBe(expected)
        const report = yield* Simulation.drain()
        expect(report.outcome).toBe("clean")
        yield* Simulation.assign(1)
        yield* untilStatus(1, 0, "open")
        expect(yield* fingerprintOn(1)).toBe(expected)
        const a = yield* Account.client("a")
        expect(yield* a.deposit(1)).toBe(94)
      }),
    ))

  it("without a runner of the old build, a runner the operator sets to replay with the current build opens it to the same state", () =>
    simulate(
      {
        seed: 81,
        shards: 1,
        checkpointEvery: 0,
        runners: [{ bundle: "v1" }, { bundle: "v2" }, { bundle: "v2", replay: "current" }],
      },
      Effect.gen(function* () {
        const expected = yield* tailFromV1
        yield* Simulation.assign(2)
        yield* untilStatus(2, 0, "open")
        expect(yield* fingerprintOn(2)).toBe(expected)
        const a = yield* Account.client("a")
        expect(yield* a.deposit(1)).toBe(94)
      }),
    ))
})

describe("cron after downtime", () => {
  const DAY = 86_400_000
  const MINUTE = 60_000

  /** The store has no owner from shortly before the first midnight until `late` after it. */
  const downtime = (late: number, seed: number) =>
    simulate(
      { seed, shards: 1, runners: [{}, {}] },
      Effect.gen(function* () {
        yield* Simulation.seed(Account, "a", { balance: 1 })
        yield* Simulation.advance("23 hours")
        expect(yield* Simulation.drain()).toMatchObject({
          outcome: "clean",
          shards: [{ shard: 0, nextDue: DAY }],
        })
        yield* TestClock.adjust(DAY + late - (yield* Clock.currentTimeMillis))
        yield* Simulation.assign(1)
        yield* Simulation.settle
        const ticked = (yield* Simulation.state(Account, "a")).ticks
        const log = yield* logOf(0)
        const skipped = log.filter(({ entry }) => Entry.guards.Skipped(entry)).length
        yield* Simulation.advance("1 day")
        return { ticked, skipped, next: (yield* Simulation.state(Account, "a")).ticks }
      }),
    )

  it("fires the tick that came due during downtime once when it is at most cronSkipIfOlderThan late, and the schedule goes on", () =>
    downtime(60 * MINUTE, 82).then((ran) =>
      expect(ran).toEqual({ ticked: 1, skipped: 0, next: 2 }),
    ))

  it("skips the tick once it is more than cronSkipIfOlderThan late, records the skip, and fires the next tick on time", () =>
    downtime(60 * MINUTE + 1, 83).then((ran) =>
      expect(ran).toEqual({ ticked: 0, skipped: 1, next: 1 }),
    ))

  it("after days of downtime skips the one pending tick and replays none of the missed ones", () =>
    downtime(3 * DAY + 5 * MINUTE, 84).then((ran) =>
      expect(ran).toEqual({ ticked: 0, skipped: 1, next: 1 }),
    ))
})
