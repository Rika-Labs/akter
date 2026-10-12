import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Actor, system } from "../index.ts"
import type { AnyHandler } from "../handlers/registry.ts"
import { Actions, maxStateBytes } from "./action.ts"
import type { Ran } from "./action.ts"
import { Outcome } from "./entries.ts"
import { Layouts } from "./layout.ts"

class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {}

const Probe = Actor.make("Probe", {
  state: Schema.Struct({
    n: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    text: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  }),
  actions: {
    touch: Actor.action(Schema.Finite, { fails: Refused, success: Schema.String }),
    sink: Actor.action(Schema.Finite, { internal: true }),
  },
  events: { touched: Actor.event(Schema.Finite) },
})

const initial = Layouts.of(Probe).initial

const run = (handler: AnyHandler, commandId = "v1.0.600000.9b2f3c1e-7a4d-4e8b-9c0d-1f2e3a4b5c6d"): Ran =>
  Actions.run({
    actor: Probe,
    handler,
    declaration: Probe.actions.touch,
    image: initial,
    commandId,
    member: "touch",
    payload: 5,
    caller: system({ source: "process", subject: "process" }),
    at: 1_000,
    key: "p",
    address: 'Probe/"p"',
    connection: undefined,
  })

interface ProbeContext {
  readonly send: (target: typeof Probe, id: string) => { readonly sink: (payload: number) => void }
  readonly schedule: (when: string) => { readonly sink: (payload: number) => void }
  readonly emit: { readonly touched: (value: number) => void }
  readonly id: () => string
  readonly now: () => number
  readonly random: () => number
}

interface ProbeState {
  n: number
  text: string
}

/** Mutates state and stages a send, a timer and an event before deciding how to end. */
const busyThen =
  <A>(end: () => A) =>
  (state: ProbeState, amount: number, ctx: ProbeContext): A => {
    state.n += amount
    ctx.send(Probe, "other").sink(amount)
    ctx.schedule("1 minute").sink(amount)
    ctx.emit.touched(amount)
    return end()
  }

const discardedEverything = (ran: Ran) => {
  expect(ran.image).toBe(initial)
  expect([ran.effects.set, ran.effects.unset, ran.effects.lists]).toEqual([{}, [], []])
  expect([ran.effects.sends, ran.effects.timers, ran.effects.starts, ran.effects.events]).toEqual([[], [], [], []])
}

describe("Actions.run", () => {
  it("keeps the draft and staged work of a successful action", () => {
    const ran = run(busyThen(() => "done"))
    expect(ran.effects.outcome).toEqual(Outcome.cases.Success.make({ value: "done" }))
    expect([ran.effects.set, ran.image.state.n, initial.state.n]).toEqual([{ n: 5 }, 5, 0])
    expect([ran.effects.sends.length, ran.effects.timers.length, ran.effects.events]).toEqual([
      1,
      1,
      [{ event: "touched", value: 5 }],
    ])
    expect(ran.effects.timers[0]?.at).toBe(61_000)
  })

  it("discards the draft and every staged effect on a declared failure, which is the outcome", () => {
    const ran = run(busyThen(() => Refused.make({ reason: "no" })))
    const wire: Schema.Json = JSON.parse('{"_tag":"Refused","reason":"no"}')
    expect(ran.effects.outcome).toEqual(Outcome.cases.Failure.make({ error: wire }))
    discardedEverything(ran)
  })

  it("discards everything on a thrown error and records a Thrown defect", () => {
    const ran = run(
      busyThen(() => {
        throw new Error("boom")
      }),
    )
    expect(ran.effects.outcome).toEqual(Outcome.cases.Defect.make({ kind: "Thrown", detail: "Error: boom" }))
    discardedEverything(ran)
  })

  it("refuses an action that awaits a promise or sleeps: the result is a defect and nothing is kept", () => {
    const ends: ReadonlyArray<() => Promise<string> | Effect.Effect<string>> = [
      () => Promise.resolve("later"),
      () => Effect.as(Effect.sleep("1 second"), "later"),
    ]
    for (const end of ends) {
      const ran = run(busyThen(end))
      expect(Outcome.guards.Defect(ran.effects.outcome) && ran.effects.outcome.kind).toBe("SynchronousActionViolation")
      discardedEverything(ran)
    }
  })

  it("refuses a context captured by an action and used after it returned", () => {
    const captured: Array<ProbeContext> = []
    run((_state: ProbeState, _amount: number, ctx: ProbeContext) => {
      captured.push(ctx)
      return "ok"
    })
    expect(() => captured[0]?.send(Probe, "other").sink(1)).toThrow(/after the action returned/)
    expect(() => captured[0]?.id()).toThrow(/after the action returned/)
  })

  it("caps encoded state at 256 KiB: exactly the cap is kept, one byte more is a StateTooLarge defect", () => {
    const overhead = JSON.stringify({ n: 0, text: "" }).length
    const fill = (length: number) => (state: ProbeState) => {
      state.text = "x".repeat(length)
      return "ok"
    }
    const atCap = run(fill(maxStateBytes - overhead))
    expect(Outcome.guards.Success(atCap.effects.outcome)).toBe(true)
    const over = run(fill(maxStateBytes - overhead + 1))
    expect(Outcome.guards.Defect(over.effects.outcome) && over.effects.outcome.kind).toBe("StateTooLarge")
    discardedEverything(over)
  })

  it("derives ids, time and randomness from the command id and admission time alone", () => {
    const draw = (state: ProbeState, _amount: number, ctx: ProbeContext) => `${ctx.id()}|${ctx.now()}|${ctx.random()}`
    const first = run(draw)
    const again = run(draw)
    const other = run(draw, "v1.0.600000.0c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5")
    expect(first.effects).toEqual(again.effects)
    expect(first.effects.outcome).not.toEqual(other.effects.outcome)
    expect([first.effects.ids, first.effects.randoms]).toEqual([1, 1])
  })
})
