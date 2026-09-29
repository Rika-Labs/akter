import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { Actor, Actors, Intent } from "../index.ts"
import { ActorTest } from "./actor-test.ts"
import { type SimulationFault, simulationSeeds } from "./simulate.ts"

const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

const Credit = Actor.command("Credit", { input: Schema.Int })

const total = Actor.state({ total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) })

const Tally = Actor.make("SimTally", { key: Schema.String, state: total, api: { Add } })

const Wallet = Actor.make("SimWallet", {
  key: Schema.String,
  state: total,
  api: {},
  internal: { Credit },
})

const Pay = Actor.command("Pay", {
  input: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const PayLater = Actor.command("PayLater", {
  input: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const Payer = Actor.make("SimPayer", { key: Schema.String, api: { Pay, PayLater } })

/** Handler runs, including runs whose turn rolled back. */
const runs = { adds: 0 }

const live = Layer.mergeAll(
  Tally.toLayer(
    Effect.succeed({
      Add: Effect.fnUntraced(function* (amount: number) {
        runs.adds += 1
        const turn = yield* Tally.Turn
        yield* turn.state.set({ total: turn.state.total + amount })

        return turn.state.total
      }),
    }),
  ),
  Wallet.toLayer(
    Effect.succeed({
      Credit: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Wallet.Turn
        yield* turn.state.set({ total: turn.state.total + amount })
      }),
    }),
  ),
  Payer.toLayer(
    Effect.succeed({
      Pay: Effect.fnUntraced(function* ({ to, amount }) {
        yield* (yield* Wallet.intents(to)).Credit(amount)
      }),
      PayLater: Effect.fnUntraced(function* ({ to, amount }) {
        yield* (yield* Wallet.intents(to)).Credit(amount).pipe(Intent.after("1 day"))
      }),
    }),
  ),
).pipe(Layer.provideMerge(ActorTest.layer({})), Layer.provide(BunCrypto.layer))

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const FAULTS: ReadonlyArray<SimulationFault> = [
  "crashBeforeCommit",
  "crashAfterCommit",
  "dropReply",
  "relayCrash",
  "clockSkew",
]

/** Direct adds and relayed payments on a few actors; returns what each should total. */
const script = (seed: string, tag = seed) =>
  ActorTest.simulate({ seed, faults: FAULTS }, (sim) =>
    Effect.gen(function* () {
      const expected = new Map<string, number>()

      for (let index = 0; index < 12; index++) {
        const amount = yield* sim.int(1, 9)
        const name = `${tag}-${yield* sim.pick(["a", "b", "c"])}`

        if ((yield* sim.int(0, 1)) === 0) {
          const tally = yield* Tally.get(name)
          const reply = yield* sim.command(`add ${name}`, tally.Add(amount))
          expected.set(`tally:${name}`, (expected.get(`tally:${name}`) ?? 0) + amount)
          expect(reply).toBe(expected.get(`tally:${name}`))
        } else {
          const payer = yield* Payer.get(`${tag}-payer`)
          yield* sim.command(`pay ${name}`, payer.Pay({ to: name, amount }), { relays: true })
          expected.set(`wallet:${name}`, (expected.get(`wallet:${name}`) ?? 0) + amount)
        }
      }

      scripted.set(tag, expected)
    }),
  )

const scripted = new Map<string, ReadonlyMap<string, number>>()

const totals = (seed: string) =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const found = new Map<string, unknown>()

    for (const key of scripted.get(seed)!.keys()) {
      const [kind, name] = key.split(":") as [string, string]
      const ref = kind === "tally" ? (yield* Tally.get(name)).ref : (yield* Wallet.get(name)).ref
      found.set(key, (yield* test.inspect(ref)).state)
    }

    return found
  })

describe("ActorTest.simulate", () => {
  it("keeps receipts and outbox delivery exactly once across seeded faults", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        for (const seed of yield* simulationSeeds) {
          const report = yield* script(`s${seed}`)
          expect(report.steps).toHaveLength(12)
          expect(yield* totals(`s${seed}`)).toEqual(
            new Map(Array.from(scripted.get(`s${seed}`)!, ([key, sum]) => [key, { total: sum }])),
          )
        }
      }),
    ))

  it("reruns a seed to the same fault schedule and outcome", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const first = yield* script("repeat", "first")
        const second = yield* script("repeat", "second")

        const schedule = (report: typeof first) =>
          report.steps.map(({ label, fault, skewMs }) => [label.split(" ")[0], fault, skewMs])

        expect(schedule(second)).toEqual(schedule(first))
        expect(first.steps.some(({ fault }) => fault !== "none")).toBe(true)

        const outcome = (tag: string) =>
          Array.from(scripted.get(tag)!, ([key, sum]) => [key.replace(tag, ""), sum])

        expect(outcome("second")).toEqual(outcome("first"))
        expect(yield* totals("second")).toEqual(
          new Map(Array.from(scripted.get("second")!, ([key, sum]) => [key, { total: sum }])),
        )
      }),
    ))

  it("dies with the seed when a step commits no receipt", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const failure = yield* ActorTest.simulate({ seed: "broken", faults: [] }, (sim) =>
          sim.command("not a command", Effect.void),
        ).pipe(Effect.exit)

        expect(String(failure)).toContain("Simulation failed with seed broken")
        expect(String(failure)).toContain("not a command")
      }),
    ))

  it("dies with the seed when a relayed command's crash is never reached", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const tally = yield* Tally.get("unrelayed")

        const failure = yield* ActorTest.simulate(
          { seed: "unrelayed", faults: ["relayCrash"], faultRate: 1 },
          (sim) => sim.command("add unrelayed", tally.Add(1), { relays: true }),
        ).pipe(Effect.exit)

        expect(String(failure)).toContain("Simulation failed with seed unrelayed")
        expect(String(failure)).toContain("beforeOutboxDelete were never reached")
      }),
    ))

  it("draws no relay crash for a command that stages no intent", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const tally = yield* Tally.get("direct")

        const report = yield* ActorTest.simulate(
          { seed: "direct", faults: ["relayCrash"], faultRate: 1 },
          (sim) => sim.command("add direct", tally.Add(1)),
        )

        expect(report.steps.map(({ fault }) => fault)).toEqual(["none"])
      }),
    ))

  it("leaves a future timer the program scheduled in the outbox", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const payer = yield* Payer.get("later-payer")
        const wallet = yield* Wallet.get("later")

        const report = yield* ActorTest.simulate({ seed: "later", faults: [] }, (sim) =>
          sim.command("pay later", payer.PayLater({ to: "later", amount: 5 })),
        )

        expect(report.steps).toHaveLength(1)
        expect((yield* (yield* ActorTest).inspect(wallet.ref)).state).not.toEqual({ total: 5 })
      }),
    ))

  it("dies with the seed when the program sends no command", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const failure = yield* ActorTest.simulate(
          { seed: "empty", faults: FAULTS },
          () => Effect.void,
        ).pipe(Effect.exit)

        expect(String(failure)).toContain("Simulation failed with seed empty")
        expect(String(failure)).toContain("the program sent no command")
      }),
    ))

  it("leaves no fault queued for the next run after a program fails", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest

        const failure = yield* ActorTest.simulate(
          { seed: "abandoned", faults: ["crashBeforeCommit"], faultRate: 1 },
          (sim) => sim.command("fails before its call", Effect.die(new Error("program failed"))),
        ).pipe(Effect.exit)

        expect(String(failure)).toContain("Simulation failed with seed abandoned")
        expect(yield* test.clearFaults).toEqual([])
      }),
    ))

  it("refuses to run over faults the caller already queued", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        yield* test.crashNext("beforeCommit")

        const failure = yield* ActorTest.simulate(
          { seed: "queued", faults: [] },
          () => Effect.void,
        ).pipe(Effect.exit)

        expect(String(failure)).toContain("were already queued")
        expect(yield* test.clearFaults).toEqual([])
      }),
    ))

  it("keeps a crash scoped to a command id queued until that command's turn", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const actors = yield* Actors
        const tally = yield* Tally.get("scoped")
        const mine = yield* actors.mintCommandId
        yield* test.crashNext("beforeCommit", { commandId: mine })

        const before = runs.adds
        expect(yield* tally.Add(1)).toBe(1)
        expect(runs.adds - before).toBe(1)
        expect(yield* test.clearFaults).toEqual(["beforeCommit"])

        yield* test.crashNext("beforeCommit", { commandId: mine })
        const crashed = runs.adds
        expect(yield* tally.Add(2).pipe(Actor.commandId(mine))).toBe(3)
        // The crashed turn ran the handler and rolled back; its retry ran it again.
        expect(runs.adds - crashed).toBe(2)
        expect(yield* test.clearFaults).toEqual([])
      }),
    ))
})
