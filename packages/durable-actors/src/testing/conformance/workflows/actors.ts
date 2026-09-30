import type { NodeInspectSymbol, Unify } from "../../../actor/definition.ts"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { WorkflowEngine } from "effect/unstable/workflow"
import { Actor, type Caller, Intent } from "../../../index.ts"
import {
  type EngineFixture,
  engineFixture,
  type EnginePrimitives,
  Flake,
  probeBody,
  ProbeInput,
} from "../workflow-engine.ts"

/** Shared by the workflow actors and every workflow case. */
export interface WorkflowsFixture {
  /** Activity runs by step and key, including runs whose outcome was lost. */
  readonly runs: Map<string, number>
  /** Holds the first run of a `block` activity until the case releases it. */
  blocked: Deferred.Deferred<void> | undefined
  /** The shared engine suite's counters and gates. */
  readonly engine: EngineFixture
  /** What each `Audit.Record` turn saw, by audit key: its tenant and caller. */
  readonly audits: Map<string, { readonly tenant: string; readonly caller: Caller }>
  /** Holds a `Watch` activity, by order id, until the case releases it. */
  readonly gates: Map<string, Deferred.Deferred<void>>
}

export const workflowsFixture = (): WorkflowsFixture => ({
  runs: new Map(),
  blocked: undefined,
  engine: engineFixture(),
  audits: new Map(),
  gates: new Map(),
})

const Paid = Actor.event("Paid", { orderId: Schema.String, amount: Schema.Int })

export class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String,
}) {}

export const Ship = Actor.workflow("Ship", {
  payload: { orderId: Schema.String, sku: Schema.String },
  success: Schema.String,
  error: OutOfStock,
  key: ({ orderId }) => orderId,
  versions: { label: { current: 2, min: 0 } },
})

const Reserve = Ship.step("reserve", {
  payload: Schema.String,
  success: Schema.String,
  error: OutOfStock,
})

const CoolOff = Ship.sleep("cool-off")

const AwaitPaid = Ship.wait("paid", Paid)

const Grace = Ship.sleep("grace")

const FirstSignal = Ship.race("first-signal", { success: Schema.String })

export const Quote = Actor.workflow("Quote", {
  payload: { n: Schema.Int },
  success: Schema.String,
})

const Pay = Actor.command("Pay", {
  payload: { orderId: Schema.String, amount: Schema.Int },
})

const Charge = Actor.command("Charge", { payload: Schema.String, success: Schema.Int })

const Record = Actor.command("Record", { payload: Schema.String })

/** Records the tenant and caller of each call it receives. */
const Audit = Actor.make("Audit", { key: Schema.String, api: { Record } })

/** Sleeps, then calls `Audit` from an activity, so the call runs after a resume. */
export const Attributed = Actor.workflow("Attributed", {
  payload: { key: Schema.String },
  success: Schema.String,
  key: ({ key }) => key,
})

const AttributedNap = Attributed.sleep("nap")

const Report = Attributed.step("report", { payload: Schema.String, success: Schema.String })

/** Owner-event waits and clocks in the shapes the W2 and clock cases need, by `mode`. */
export const Watch = Actor.workflow("Watch", {
  payload: { mode: Schema.String, orderId: Schema.String },
  success: Schema.String,
  key: ({ mode, orderId }) => `${mode}/${orderId}`,
})

const WatchHold = Watch.step("hold", { payload: Schema.String, success: Schema.String })

const WatchSlow = Watch.step("slow", { payload: Schema.String, success: Schema.String })

const WatchFirst = Watch.wait("first", Paid)

const WatchSecond = Watch.wait("second", Paid)

const WatchPick = Watch.race("pick", { success: Schema.String })

const WatchNapA = Watch.sleep("nap-a")

const WatchNapB = Watch.sleep("nap-b")

const WatchMarkA = Watch.step("mark-a", { payload: Schema.String, success: Schema.String })

const WatchMarkB = Watch.step("mark-b", { payload: Schema.String, success: Schema.String })

const WatchLong = Watch.sleep("long")

const WatchEmit = Watch.step("emit", { payload: Schema.String, success: Schema.String })

const Emit = Actor.command("Emit", {
  payload: { orderId: Schema.String, amount: Schema.Int },
})

/** Waits for a `Paid` event for order `k`, with no timeout. */
const Held = Actor.workflow("Held", { success: Schema.String })

const HeldPaid = Held.wait("paid", Paid)

/** Prunes events after an hour, so a case can see which ones a pending wait pins. */
export const Keeper = Actor.make("Keeper", {
  key: Schema.String,
  events: [Paid],
  api: { Emit, Held },
  policy: { keepEvents: "1 hour" },
})

/** Creates a step constructor inside its body, which the engine must refuse. */
const Loose = Actor.workflow("Loose", { success: Schema.String })

let looseSteps = 0

export const Ledger = Actor.make("Ledger", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Charge },
})

const Begin = Actor.command("Begin", {
  payload: { orderId: Schema.String, sku: Schema.String },
  success: Schema.String,
})

const Defer = Actor.command("Defer", {
  payload: { orderId: Schema.String, sku: Schema.String },
  success: Schema.String,
})

export const Shipper = Actor.make("Shipper", {
  key: Schema.String,
  events: [Paid],
  api: { Ship, Quote, Pay, Begin, Attributed, Loose, Watch, Defer },
})

export const Probe = Actor.workflow("Probe", {
  payload: ProbeInput,
  success: Schema.String,
  error: Flake,
  key: ({ scenario, key }) => `${scenario}/${key}`,
})

const probeSteps = {
  once: Probe.step("once", { success: Schema.String, error: Flake }),
  fast: Probe.step("fast", { success: Schema.String, error: Flake }),
  hold: Probe.step("hold", { success: Schema.String, error: Flake }),
  flaky: Probe.step("flaky", { success: Schema.String, error: Flake }),
}

const Nap = Probe.sleep("nap")

const Pick = Probe.race("pick", { success: Schema.String })

/** Reports whether a body can reach an Effect `WorkflowEngine`, as `DurableDeferred.done` needs. */
const Inspect = Actor.workflow("Inspect", { success: Schema.String })

export const EngineProbe = Actor.make("EngineProbe", {
  key: Schema.String,
  api: { Probe, Inspect },
})

const probePrimitives: EnginePrimitives<never> = {
  activity: (name, execute) => probeSteps[name].run(undefined, () => execute),
  sleep: (_, duration) => Nap(duration),
  race: (_, effects) => Pick.run(effects),
}

const bump = (fixture: WorkflowsFixture, key: string) =>
  Effect.sync(() => fixture.runs.set(key, (fixture.runs.get(key) ?? 0) + 1))

const LedgerLive = Ledger.toLayer(
  Effect.succeed({
    Charge: Effect.fnUntraced(function* () {
      const turn = yield* Ledger.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })

      return turn.state.count
    }),
  }),
)

export const workflowsLayer = (fixture: WorkflowsFixture) =>
  Layer.mergeAll(
    LedgerLive,
    Keeper.toLayer(
      Effect.succeed({
        Emit: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly amount: number
        }) {
          yield* (yield* Keeper.Turn).emit(Paid.make(input))
        }),
        Held: () =>
          HeldPaid({ where: (event) => event.orderId === "k" }).pipe(
            Effect.map(
              Option.match({ onNone: () => "unpaid", onSome: (event) => `paid-${event.amount}` }),
            ),
          ),
      }),
    ),
    Audit.toLayer(
      Effect.succeed({
        Record: Effect.fnUntraced(function* (key: string) {
          const turn = yield* Audit.Turn
          fixture.audits.set(key, { tenant: turn.ref.tenant, caller: turn.caller })
        }),
      }),
    ),
    EngineProbe.toLayer(
      Effect.succeed({
        Probe: (input: { readonly scenario: string; readonly key: string }) =>
          probeBody({ primitives: probePrimitives, fixture: fixture.engine, input }),
        Inspect: () =>
          Effect.serviceOption(WorkflowEngine.WorkflowEngine).pipe(
            Effect.map((engine) => (Option.isSome(engine) ? "present" : "absent")),
          ),
      }),
    ),
    Shipper.toLayer(
      Effect.succeed({
        Begin: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly sku: string
        }) {
          const turn = yield* Shipper.Turn
          yield* turn.emit(Paid.make({ orderId: input.orderId, amount: 3 }))

          return yield* (yield* Shipper.intents(turn.id)).Ship(input)
        }),
        Defer: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly sku: string
        }) {
          const turn = yield* Shipper.Turn

          return yield* (yield* Shipper.intents(turn.id))
            .Ship(input)
            .pipe(Intent.after("500 millis"))
        }),
        Pay: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly amount: number
        }) {
          const turn = yield* Shipper.Turn

          yield* turn.emit(Paid.make(input))
        }),
        Quote: (input: { readonly n: number }) => Effect.succeed(`q-${input.n}`),
        Attributed: Effect.fnUntraced(function* (input: { readonly key: string }) {
          const wf = yield* Shipper.Workflow
          yield* AttributedNap("10 seconds")

          yield* Report.run(input.key, (key) =>
            Effect.gen(function* () {
              yield* (yield* Audit.get(key)).Record(key).pipe(Effect.orDie)

              return key
            }),
          )

          return Option.match(wf.principal, {
            onNone: () => "anonymous",
            onSome: ({ subject }) => subject,
          })
        }),
        Watch: Effect.fnUntraced(function* (input: {
          readonly mode: string
          readonly orderId: string
        }) {
          const { mode, orderId } = input

          const gated = (step: typeof WatchHold | typeof WatchSlow, label: string) =>
            step.run(orderId, (key) =>
              Effect.gen(function* () {
                yield* bump(fixture, `${label}:${key}`)
                const gate = fixture.gates.get(key)

                if (gate !== undefined) yield* Deferred.await(gate)

                return label
              }),
            )

          const marked = (step: typeof WatchMarkA | typeof WatchMarkB, label: string) =>
            step.run(orderId, (key) => bump(fixture, `${label}:${key}`).pipe(Effect.as(label)))

          const paid = (wait: typeof WatchFirst | typeof WatchSecond, where: boolean) =>
            wait({
              where: where ? (event) => event.orderId === orderId : undefined,
              timeout: "1 minute",
            }).pipe(
              Effect.map(
                Option.match({ onNone: () => "unpaid", onSome: (event) => `paid-${event.amount}` }),
              ),
            )

          switch (mode) {
            case "gated":
              yield* gated(WatchHold, "hold")

              return yield* paid(WatchFirst, true)

            case "plain":
              return yield* paid(WatchFirst, true)

            case "any":
              return yield* paid(WatchFirst, false)

            case "two":
              return `${yield* paid(WatchFirst, true)}|${yield* paid(WatchSecond, true)}`

            case "race":
              return yield* WatchPick.run([paid(WatchFirst, true), gated(WatchSlow, "slow")])

            case "clocks":
              yield* Effect.all(
                [
                  WatchNapA("5 seconds").pipe(Effect.andThen(marked(WatchMarkA, "mark-a"))),
                  WatchNapB("10 seconds").pipe(Effect.andThen(marked(WatchMarkB, "mark-b"))),
                ],
                { concurrency: "unbounded" },
              )

              return "clocks"

            case "phases":
              yield* WatchNapA("5 seconds")
              yield* gated(WatchHold, "hold")
              yield* WatchNapB("5 seconds")

              return "phases"

            case "long":
              yield* WatchLong("10 seconds")

              return yield* marked(WatchMarkA, "slept")

            case "sibling": {
              const { id } = yield* Shipper.Workflow

              const [waited, emitted] = yield* Effect.all(
                [
                  paid(WatchFirst, true),
                  WatchEmit.run(orderId, (key) =>
                    Effect.gen(function* () {
                      yield* bump(fixture, `emit:${key}`)
                      const gate = fixture.gates.get(key)

                      if (gate !== undefined) yield* Deferred.await(gate)
                      yield* (yield* Shipper.get(id))
                        .Pay({ orderId: key, amount: 8 })
                        .pipe(Effect.orDie)

                      return "emitted"
                    }),
                  ),
                ],
                { concurrency: "unbounded" },
              )

              return `${waited}|${emitted}`
            }
          }

          return yield* Effect.die(new Error(`Unknown mode ${mode}`))
        }),
        Loose: Effect.fnUntraced(function* () {
          looseSteps += 1
          const Late = Loose.step(`late-${looseSteps}`, { success: Schema.String })

          return yield* Late.run(undefined, () => Effect.succeed("ran"))
        }),
        Ship: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly sku: string
        }) {
          const wf = yield* Shipper.Workflow

          const reservation = yield* Reserve.run(input.sku, (sku) =>
            Effect.gen(function* () {
              yield* bump(fixture, `reserve:${input.orderId}`)

              if (sku === "none") return yield* OutOfStock.make({ sku })

              if (sku.startsWith("charge")) {
                const ledger = yield* Ledger.get(input.orderId)
                const first = yield* ledger.Charge(sku).pipe(Effect.orDie)
                const gate = fixture.blocked

                if (sku.includes("block") && gate !== undefined) {
                  fixture.blocked = undefined
                  yield* Deferred.await(gate)
                }

                const again = yield* ledger.Charge(sku).pipe(Effect.orDie)

                return `r-${sku}-${first}-${again}`
              }

              const gate = fixture.blocked

              if ((sku.startsWith("block") || sku.startsWith("late")) && gate !== undefined) {
                fixture.blocked = undefined
                yield* Deferred.await(gate)
              }

              if (sku.startsWith("late"))
                return `r-${sku}-${yield* (yield* Ledger.get(input.orderId)).Charge(sku).pipe(Effect.orDie)}`

              return `r-${sku}`
            }),
          )

          const label = yield* wf.version("label")

          if (input.sku.startsWith("twice"))
            return `${reservation}|${yield* Reserve.run("again", (sku) => Effect.succeed(`r-${sku}`))}`

          if (input.sku.startsWith("outside"))
            yield* (yield* Ledger.get(input.orderId)).Charge(input.sku).pipe(Effect.orDie)

          if (input.sku.startsWith("sleep")) yield* CoolOff("10 seconds")

          if (input.sku.startsWith("race"))
            return `${reservation}:${yield* FirstSignal.run([
              AwaitPaid({
                where: (event) => event.orderId === input.orderId,
                timeout: "1 minute",
              }).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => "unpaid",
                    onSome: (event) => `paid-${event.amount}`,
                  }),
                ),
              ),
              Grace("10 seconds").pipe(Effect.as("grace")),
            ])}`

          if (input.sku.startsWith("wait")) {
            const paid = yield* AwaitPaid({
              where: (event) => event.orderId === input.orderId,
              timeout: "1 minute",
            })

            return Option.match(paid, {
              onNone: () => `${reservation}:unpaid`,
              onSome: (event) => `${reservation}:paid-${event.amount}`,
            })
          }

          return `${reservation}:v${label}`
        }),
      }),
    ),
  )

export const workflowsLive = (fixture: WorkflowsFixture) => Layer.mergeAll(workflowsLayer(fixture))

export type { NodeInspectSymbol, Unify }
