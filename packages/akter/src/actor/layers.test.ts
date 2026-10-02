import { BunCrypto } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect"
import { afterAll, describe, expect, expectTypeOf, it } from "vitest"
import { Actor, type Caller, CurrentCaller, System } from "../index.ts"
import { ActorTest } from "../testing/actor-test.ts"
import type { InternalActors } from "../runtime/actors.ts"

class Unconfigured extends Schema.TaggedError<Unconfigured>()("Unconfigured", {}) {}

const Ping = Actor.command("Ping", { success: Schema.Int })

/** How often each builder ran, as whom, and how many resources singleton builds hold. */
const builds = {
  ordinary: 0,
  singleton: 0,
  open: 0,
  released: 0,
  callers: [] as Array<Caller>,
}

const Keyed = Actor.make("LayersKeyed", { key: Schema.String, api: { Ping } })

const Solo = Actor.make("LayersSolo", { key: Actor.singleton, api: { Ping } })

const KeyedLive = Keyed.toLayer(
  Effect.gen(function* () {
    builds.ordinary += 1
    builds.callers.push(yield* CurrentCaller)

    return { Ping: () => Effect.succeed(builds.ordinary) }
  }),
)

const SoloLive = Solo.toLayer(
  Effect.gen(function* () {
    builds.singleton += 1
    builds.callers.push(yield* CurrentCaller)
    yield* Effect.acquireRelease(
      Effect.sync(() => (builds.open += 1)),
      () =>
        Effect.sync(() => {
          builds.open -= 1
          builds.released += 1
        }),
    )

    return { Ping: () => Effect.succeed(builds.singleton) }
  }),
)

const runtime = ManagedRuntime.make(
  Layer.mergeAll(KeyedLive, SoloLive).pipe(
    Layer.provideMerge(ActorTest.layer({})),
    Layer.provide(BunCrypto.layer),
  ),
)

afterAll(() => runtime.dispose())

describe("handler layer lifetimes", () => {
  it("builds an ordinary actor's handlers at layer build and a singleton's at its activation", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const first = yield* Keyed.get("a")
        const second = yield* Keyed.get("b")
        expect(yield* first.Ping()).toBe(1)
        expect(yield* second.Ping()).toBe(1)
        expect(builds.ordinary).toBe(1)

        const solo = yield* Solo.get()
        expect(yield* solo.Ping()).toBe(1)
        expect(yield* solo.Ping()).toBe(1)
        expect(builds).toMatchObject({ ordinary: 1, singleton: 1, open: 1, released: 0 })
        expect(builds.callers).toContainEqual(System.make({ source: "actor", ref: solo.ref }))
        expect(
          builds.callers.filter((caller) => Schema.is(System)(caller) && caller.source === "actor"),
        ).toHaveLength(1)
      }),
    ))

  it("releases what a singleton build acquired when its activation ends", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const opened = { open: 0, released: 0 }
        const Lone = Actor.make("LayersLone", { key: Actor.singleton, api: { Ping } })

        const owned = ManagedRuntime.make(
          Lone.toLayer(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => (opened.open += 1)),
                () =>
                  Effect.sync(() => {
                    opened.open -= 1
                    opened.released += 1
                  }),
              )

              return { Ping: () => Effect.succeed(opened.open) }
            }),
          ).pipe(Layer.provideMerge(ActorTest.layer({})), Layer.provide(BunCrypto.layer)),
        )

        const pinged = yield* Effect.promise(() =>
          owned.runPromise(Effect.flatMap(Lone.get(), (lone) => lone.Ping())),
        )

        expect(pinged).toBe(1)
        yield* Effect.promise(() => owned.dispose())
        expect(opened).toEqual({ open: 0, released: 1 })
      }),
    ))

  it("fails an ordinary layer with its builder's typed error when the layer is built", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const Broken = Actor.make("LayersBroken", { key: Schema.String, api: { Ping } })
        const layer = Broken.toLayer(Effect.fail(Unconfigured.make({})))

        expectTypeOf(layer).toEqualTypeOf<Layer.Layer<never, Unconfigured, InternalActors>>()

        const exit = yield* Layer.build(layer).pipe(Effect.scoped, Effect.exit)

        expect(
          Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        ).toEqual(Unconfigured.make({}))
      }),
    ))

  it("fails a singleton's activation, not its layer, when its builder fails", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const Fragile = Actor.make("LayersFragile", { key: Actor.singleton, api: { Ping } })
        const layer = Fragile.toLayer(Effect.fail(Unconfigured.make({})))

        expectTypeOf(layer).toEqualTypeOf<Layer.Layer<never, never, InternalActors>>()

        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(layer)
            const fragile = yield* Fragile.get()

            return yield* fragile.Ping().pipe(Effect.exit)
          }),
        )

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(Unconfigured.make({}))
      }),
    ))
})
