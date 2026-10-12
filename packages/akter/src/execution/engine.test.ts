import { describe, expect, it } from "@effect/vitest"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Result, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import {
  ActionDefect,
  Actor,
  ActorError,
  ActorUnavailable,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  Unauthorized,
  anonymous,
  system,
  user,
} from "../index.ts"
import type { Caller } from "../contract/caller.ts"
import type { Client } from "../contract/handle.ts"
import { Simulation, SimulationService } from "../testing/index.ts"
import type { SimulationOptions } from "../testing/index.ts"
import { CommandIds } from "./command-ids.ts"
import { Durable } from "./durable.ts"
import { Entry, EntryCodec, Origin, Outcome } from "./entries.ts"
import type { ActionEntry } from "./entries.ts"
import { storeOf } from "../store/service.ts"
import { Transports } from "./transport.ts"

class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

const Wallet = Actor.make("Wallet", {
  state: Schema.Struct({
    balance: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    credits: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    deposit: Actor.action(Schema.Finite, { success: Schema.Finite }),
    pay: Actor.action(
      Schema.Struct({
        to: Schema.String,
        amount: Schema.Finite,
        end: Schema.Literals(["ok", "fail", "throw"]),
      }),
      { fails: Refused },
    ),
    credit: Actor.action(Schema.Finite, { internal: true }),
  },
  events: { changed: Actor.event(Schema.Finite) },
})

const WalletLive = Wallet.toLayer({
  deposit: (wallet, amount, { emit }) => {
    wallet.balance += amount
    emit.changed(wallet.balance)
    return wallet.balance
  },
  pay: (wallet, { to, amount, end }, { send, schedule, emit }) => {
    wallet.balance -= amount
    send(Wallet, to).credit(amount)
    schedule("1 minute").credit(amount)
    emit.changed(wallet.balance)
    if (end === "fail") return Refused.make({ reason: "declared" })
    if (end === "throw") throw new Error("boom")
  },
  credit: (wallet, amount) => {
    wallet.balance += amount
    wallet.credits += 1
  },
})

type WalletOptions = Omit<SimulationOptions<ReadonlyArray<typeof Wallet>>, "actors">

const slowLog: WalletOptions = {
  seed: 0,
  faults: ["slowLog"],
  rates: {
    crashBefore: 0,
    crashAfter: 0,
    lostResponse: 0,
    unavailable: 0,
    maxOutage: 0,
    slow: 1,
    maxDelayTurns: 40,
  },
}

const simulate = <A, E>(
  options: WalletOptions,
  program: Effect.Effect<A, E, SimulationService | Client | TestClock.TestClock | Scope.Scope>,
) => Simulation.run({ actors: [Wallet], ...options }, Effect.scoped(program), WalletLive)

/** Every action entry the log holds for one wallet, decoded from the stored segments. */
const actionsOf = (key: string) =>
  Effect.gen(function* () {
    const simulator = yield* SimulationService
    const shard = simulator.engine.shardOf(Durable.addressOf("Wallet", key))
    const logs = yield* simulator.logs
    return (logs[shard]?.segments ?? [])
      .flatMap((segment) =>
        segment.entries.map((bytes) => Result.getOrThrow(EntryCodec.decode(bytes))),
      )
      .filter((entry): entry is ActionEntry => Entry.guards.Action(entry) && entry.key === key)
  })

/** Yields to the scheduler until an append is in flight, so a crash lands before it is durable. */
const untilInFlight = Effect.gen(function* () {
  const simulator = yield* SimulationService
  for (let turn = 0; turn < 1_000; turn++) {
    const now = yield* Clock.currentTimeMillis
    if (simulator.engine.busy(now)?.includes("in flight") === true) return
    yield* Effect.yieldNow
  }
  return yield* Effect.die(new Error("nothing reached the log"))
})

const keysOnDistinctShards = Effect.map(SimulationService, (simulator) => {
  const shardOf = (key: string) => simulator.engine.shardOf(Durable.addressOf("Wallet", key))
  const keys = Array.from({ length: 64 }, (_, index) => `w${index}`)
  const first = keys[0] ?? "w0"
  const other = keys.find((key) => shardOf(key) !== shardOf(first)) ?? first
  return { first, other, from: shardOf(first), to: shardOf(other) }
})

describe("F1: a declared failure or a defect discards the action's staged effects", () => {
  it("publishes no event, delivers no send and fires no timer from a discarded action, and records its outcome", () =>
    simulate(
      { seed: 21 },
      Effect.gen(function* () {
        yield* Simulation.seed(Wallet, "a", { balance: 100 })
        const a = yield* Wallet.client("a")
        const events: Array<number> = []
        yield* Effect.forkChild(
          Stream.runForEach(a.changed, (value) => Effect.sync(() => events.push(value))),
        )
        yield* Effect.yieldNow
        yield* a.deposit(1)
        yield* Simulation.settle
        expect(events).toEqual([101])
        const declared = yield* Effect.flip(a.pay({ to: "b", amount: 10, end: "fail" }))
        const thrown = yield* Effect.exit(a.pay({ to: "b", amount: 10, end: "throw" }))
        yield* Simulation.advance("2 minutes")
        expect(declared).toEqual(Refused.make({ reason: "declared" }))
        const defect = Exit.isFailure(thrown) ? Cause.squash(thrown.cause) : undefined
        expect(Schema.is(ActionDefect)(defect) && defect.kind).toBe("Thrown")
        expect(events).toEqual([101])
        const [after, b] = yield* Effect.all([
          Simulation.state(Wallet, "a"),
          Simulation.state(Wallet, "b"),
        ])
        expect([after.balance, after.credits, b.balance, b.credits]).toEqual([101, 0, 0, 0])
        const outcomes = (yield* actionsOf("a")).map((entry) => entry.effects.outcome._tag)
        expect(outcomes).toEqual(["Success", "Failure", "Defect"])

        yield* a.pay({ to: "b", amount: 10, end: "ok" })
        yield* Simulation.advance("2 minutes")
        const [paid, credited] = yield* Effect.all([
          Simulation.state(Wallet, "a"),
          Simulation.state(Wallet, "b"),
        ])
        expect([paid.balance, paid.credits, credited.balance, credited.credits, events]).toEqual([
          101,
          1,
          10,
          1,
          [101, 91],
        ])
      }),
    ))
})

describe("F3 and F5: a crash between execution and append", () => {
  it("F5: shows nothing before the segment is durable, and the client's retry with the same id applies once", () =>
    simulate(
      { ...slowLog, seed: 31 },
      Effect.gen(function* () {
        yield* Simulation.seed(Wallet, "a", { balance: 100 })
        yield* Simulation.settle
        const a = yield* Wallet.client("a")
        const frames: Array<number> = []
        const events: Array<number> = []
        yield* Effect.forkChild(
          Stream.runForEach(a.state, (state) => Effect.sync(() => frames.push(state.balance))),
        )
        yield* Effect.forkChild(
          Stream.runForEach(a.changed, (value) => Effect.sync(() => events.push(value))),
        )
        yield* Effect.yieldNow
        const call = yield* Effect.forkChild(a.deposit(5))
        yield* untilInFlight
        const nothingVisible = Effect.gen(function* () {
          expect(call.pollUnsafe()).toBeUndefined()
          expect((yield* Simulation.state(Wallet, "a")).balance).toBe(100)
          expect([frames, events]).toEqual([[100], []])
        })
        yield* nothingVisible
        yield* Simulation.crash(Wallet, "a")
        yield* nothingVisible
        yield* Simulation.settle
        expect(yield* Fiber.join(call)).toBe(105)
        expect([frames, events]).toEqual([[100, 105], [105]])
        expect((yield* actionsOf("a")).filter((entry) => entry.member === "deposit").length).toBe(1)
      }),
    ))

  it("F3: a same-shard send whose sender entry is lost never delivers; the retried id runs both once", () =>
    simulate(
      { ...slowLog, seed: 32, shards: 1 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        yield* Simulation.seed(Wallet, "a", { balance: 100 })
        yield* Simulation.settle
        const now = yield* Clock.currentTimeMillis
        const commandId = yield* CommandIds.mint(now)
        const pay = Transports.admit(simulator.engine, user("ana"), commandId, {
          actor: Wallet,
          id: "a",
          member: "pay",
          payload: { to: "b", amount: 10, end: "ok" },
        })
        const lost = yield* Effect.forkChild(pay)
        yield* untilInFlight
        yield* Simulation.crash(Wallet, "a")
        const refusal = yield* Effect.flip(Fiber.join(lost))
        yield* Simulation.settle
        expect(refusal).toEqual(ActorError.make({ reason: ActorUnavailable.make({}) }))
        const b = yield* Simulation.state(Wallet, "b")
        expect([b.balance, b.credits, (yield* actionsOf("b")).length]).toEqual([0, 0, 0])

        expect(yield* pay).toEqual({ kind: "Success", value: null })
        yield* Simulation.settle
        const [after, credited] = yield* Effect.all([
          Simulation.state(Wallet, "a"),
          Simulation.state(Wallet, "b"),
        ])
        expect([after.balance, after.credits, credited.balance, credited.credits]).toEqual([
          100, 1, 10, 1,
        ])
        expect((yield* actionsOf("b")).filter((entry) => entry.member === "credit").length).toBe(1)
      }),
    ))
})

describe("F4: duplicate command ids", () => {
  it("runs a client id once during its window, answers retries from the record, and refuses misuse and expiry", () =>
    simulate(
      { seed: 41 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        yield* Simulation.seed(Wallet, "a", { balance: 100 })
        const now = yield* Clock.currentTimeMillis
        const commandId = yield* CommandIds.mint(now)
        const ana = user("ana")
        const deposit = (payload: number, caller = ana) =>
          Transports.admit(simulator.engine, caller, commandId, {
            actor: Wallet,
            id: "a",
            member: "deposit",
            payload,
          })
        const concurrent = yield* Effect.all([deposit(5), deposit(5)], { concurrency: "unbounded" })
        const retried = yield* deposit(5)
        expect([...concurrent, retried]).toEqual([
          { kind: "Success", value: 105 },
          { kind: "Success", value: 105 },
          { kind: "Success", value: 105 },
        ])
        expect(yield* Effect.flip(deposit(6))).toEqual(
          ActorError.make({ reason: InvalidCommandId.make({ commandId, code: "conflict" }) }),
        )
        expect(yield* Effect.flip(deposit(5, user("eve")))).toEqual(
          ActorError.make({ reason: Unauthorized.make({ code: "outcome_access_denied" }) }),
        )
        yield* TestClock.adjust(Duration.millis(600_000))
        expect(yield* Effect.flip(deposit(5))).toEqual(
          ActorError.make({ reason: CommandExpired.make({ commandId }) }),
        )
        expect((yield* Simulation.state(Wallet, "a")).balance).toBe(105)
        expect(
          (yield* actionsOf("a")).filter((entry) => entry.commandId === commandId).length,
        ).toBe(1)
      }),
    ))

  it("applies a redelivered cross-shard send once by its stream watermark and refuses a sequence gap", () =>
    simulate(
      { seed: 42 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const { first, other, from, to } = yield* keysOnDistinctShards
        expect(from).not.toBe(to)
        yield* Simulation.seed(Wallet, first, { balance: 100 })
        const payer = yield* Wallet.client(first)
        yield* payer.pay({ to: other, amount: 10, end: "ok" })
        yield* Simulation.settle
        const paid = (yield* actionsOf(first)).find((entry) => entry.member === "pay")
        const send = paid?.effects.sends[0]
        if (send === undefined) return yield* Effect.die(new Error("the payment staged no send"))
        const redeliver = (sequence: number) =>
          simulator.engine.execute({
            origin: Origin.cases.Delivery.make({ stream: `${from}>${to}`, sequence }),
            commandId: send.commandId,
            actor: Wallet,
            keyJson: send.key,
            member: send.member,
            payload: send.payload,
            caller: system({ source: "send", subject: `actor:Wallet/${first}` }),
            connection: undefined,
          })
        expect(yield* redeliver(1)).toEqual(Outcome.cases.Success.make({ value: null }))
        expect(yield* Effect.flip(redeliver(3))).toEqual(
          ActorError.make({ reason: ActorUnavailable.make({}) }),
        )
        const receiver = yield* Simulation.state(Wallet, other)
        expect([receiver.balance, receiver.credits]).toEqual([10, 1])
      }),
    ))

  it("answers a replayed job call from the receiver's stored outcome without running it again", () =>
    simulate(
      { seed: 43 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const call = simulator.engine.execute({
          origin: Origin.cases.JobCall.make({ jobId: "job-1" }),
          commandId: CommandIds.derive("job-1", "body", 1, 0),
          actor: Wallet,
          keyJson: "a",
          member: "deposit",
          payload: 7,
          caller: system({ source: "job", subject: "job:job-1" }),
          connection: undefined,
        })
        const first = yield* call
        const replayed = yield* call
        expect([first, replayed]).toEqual([
          Outcome.cases.Success.make({ value: 7 }),
          Outcome.cases.Success.make({ value: 7 }),
        ])
        expect((yield* Simulation.state(Wallet, "a")).balance).toBe(7)
      }),
    ))
})

describe("admission", () => {
  it("refuses internal members, undecodable payloads and, by default, anonymous callers before running", () =>
    simulate(
      { seed: 51 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const call = (member: string, payload: Schema.Json, caller: Caller = user("ana")) =>
          Effect.flip(simulator.client(caller).call({ actor: Wallet, id: "a", member, payload }))
        expect(yield* call("credit", 1)).toEqual(
          ActorError.make({
            reason: InvalidInput.make({
              code: "unknown_member",
              issues: [{ path: "credit", message: "not a public member" }],
            }),
          }),
        )
        expect(Schema.is(InvalidInput)((yield* call("deposit", "five")).reason)).toBe(true)
        expect(yield* call("deposit", 1, anonymous)).toEqual(
          ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
        )
        expect((yield* actionsOf("a")).length).toBe(0)
      }),
    ))
})

describe("reads and the lease", () => {
  it("answers reads from memory within validFor, and once it has passed refuses them on a lease another owner fenced", () =>
    simulate(
      { seed: 52 },
      Effect.gen(function* () {
        const simulator = yield* SimulationService
        const wallet = yield* Wallet.client("a")
        yield* wallet.deposit(5)
        const other = yield* Effect.orDie(
          storeOf(simulator.bucket.inspect, { writer: "another owner" }),
        )
        yield* Effect.orDie(other.open(simulator.engine.shardOf(Durable.addressOf("Wallet", "a"))))
        expect((yield* simulator.engine.durableRecord(Wallet, "a")).image.state).toMatchObject({
          balance: 5,
        })
        yield* TestClock.adjust("11 seconds")
        const refused = yield* Effect.flip(simulator.engine.durableRecord(Wallet, "a"))
        expect(Schema.is(ActorUnavailable)(refused.reason)).toBe(true)
      }),
    ))
})
