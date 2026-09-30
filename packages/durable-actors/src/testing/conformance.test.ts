import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Actor } from "../index.ts"
import {
  type ConformanceBackend,
  type ConformanceCase,
  type ConformanceRegistrar,
  type ConformanceSuite,
  registerConformance,
} from "./conformance.ts"

const Poke = Actor.command("Poke", { output: Schema.Finite })

const Probe = Actor.make("HarnessProbe", { key: Schema.String, api: { Poke } })

interface ProbeFixture {
  readonly events: Array<string>
}

const built: Array<string> = []

const recordsBuild = (label: string) => Layer.effectDiscard(Effect.sync(() => built.push(label)))

const dependencySuite: ConformanceSuite = { layer: () => recordsBuild("dependency") }

const probeSuite: ConformanceSuite<ProbeFixture> = {
  fixture: () => ({ events: [] }),
  uses: [dependencySuite],
  layer: () =>
    Layer.merge(
      recordsBuild("probe"),
      Probe.toLayer(Effect.succeed({ Poke: () => Effect.succeed(1) })),
    ),
}

const cases: ReadonlyArray<ConformanceCase<ProbeFixture>> = [
  {
    name: "hangs holding authorization closed until its signal aborts",
    run: ({ environment, fixture, access }) =>
      environment.run(
        Effect.sync(() => {
          access.allowed = false
          fixture.events.push("hang started")
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => fixture.events.push("hang finalized"))),
        ),
      ),
  },
  {
    name: "starts after the aborted case finalized, with authorization open",
    run: ({ environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          fixture.events.push("next started")
          expect(yield* (yield* Probe.get("after-abort")).Poke()).toBe(1)
        }),
      ),
  },
  {
    name: "opens a fresh database without declaring it",
    run: ({ environment }) => environment.run(Effect.asVoid(environment.freshDatabase)),
  },
  {
    name: "opens a fresh database it declares",
    requiresFreshDatabase: true,
    run: ({ environment }) => environment.run(Effect.asVoid(environment.freshDatabase)),
  },
  {
    name: "needs a second connection",
    requiresIndependentConnections: true,
    run: () => Promise.reject(new Error("a skipped case never runs")),
  },
]

const backend: ConformanceBackend = {
  independentConnections: false,
  freshDatabases: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  open: () =>
    Promise.resolve({
      database: {},
      freshDatabase: Effect.succeed({}),
      copy: () => Effect.die(new Error("not copied")),
      close: Effect.void,
    }),
}

interface Registered {
  readonly name: string
  readonly body: (context: { readonly signal?: AbortSignal | undefined }) => Promise<void>
}

/** Collects what the harness registers, so the test drives it the way a runner would. */
const collect = () => {
  const registered: Array<Registered> = []
  const skipped: Array<string> = []
  const before: Array<() => Promise<void> | void> = []
  const after: Array<() => Promise<void> | void> = []

  const registrar: ConformanceRegistrar = {
    describe: (_name, body) => body(),
    it: (name, body) => registered.push({ name, body }),
    beforeAll: (body) => before.push(body),
    afterAll: (body) => after.push(body),
    expect,
    skip: (name) => skipped.push(name),
  }

  return { registrar, registered, skipped, before, after }
}

/** Runs one registered case and returns its failure message, if it failed. */
const run = (registered: Registered, signal?: AbortSignal) =>
  Effect.tryPromise(() => registered.body({ signal })).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined)),
  )

/** Runs each lifecycle hook the harness registered, in order. */
const hooks = (registered: ReadonlyArray<() => Promise<void> | void>) =>
  Effect.forEach(registered, (hook) => Effect.promise(() => Promise.resolve(hook())), {
    discard: true,
  })

describe("conformance harness", () => {
  it.live(
    "interrupts a timed-out case, finalizes it before the next case, and builds each selected suite and its dependencies once",
    () =>
      Effect.gen(function* () {
        const { registrar, registered, skipped, before, after } = collect()
        const fixture: ProbeFixture = { events: [] }
        const suite: ConformanceSuite<ProbeFixture> = { ...probeSuite, fixture: () => fixture }

        registerConformance({
          name: "harness",
          backend,
          registrar,
          selected: [
            { suite, cases: cases.slice(0, 2) },
            { suite, cases: cases.slice(2) },
          ],
        })

        expect(registered.map(({ name }) => name)).toEqual(
          cases.slice(0, 4).map(({ name }) => name),
        )
        expect(skipped).toEqual(["needs a second connection"])
        expect(built).toEqual([])
        yield* hooks(before)
        expect(built).toEqual(["dependency", "probe"])

        const [hang, next, undeclared, declared] = registered

        const hanging = yield* Effect.abortSignal.pipe(
          Effect.flatMap((signal) => run(hang!, signal)),
          Effect.scoped,
          Effect.forkChild,
        )

        yield* Effect.sleep("100 millis")
        expect(fixture.events).toEqual(["hang started"])
        yield* Fiber.interrupt(hanging)

        expect(yield* run(next!)).toBeUndefined()
        expect(fixture.events).toEqual(["hang started", "hang finalized", "next started"])
        expect(yield* run(undeclared!)).toContain("without declaring requiresFreshDatabase")
        expect(yield* run(declared!)).toBeUndefined()

        yield* hooks(after)
      }),
    30_000,
  )
})
