import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect"
import { expect, it } from "@effect/vitest"
import { evaluate, flag, InvalidOverride, UnknownFlag } from "./evaluation.ts"
import { makeFlags } from "./layer.ts"
import { memoryStore, OverrideStore, StoreError } from "./store.ts"

const registry = { mode: flag(Schema.String)("default") }
const { Flags, layer } = makeFlags(registry)

interface DynamicRegistry {
  readonly [key: string]: typeof registry.mode
}

it.effect(
  "reads updated rules, rejects invalid replacement, deletes and isolates memory layer builds",
  () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(layer.pipe(Layer.provide(memoryStore)))
      try {
        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              const flags = yield* Flags
              expect(yield* flags.evaluate("mode", {})).toBe("default")
              yield* flags.set("mode", { value: "saved", users: { alice: "private" } })
              expect(yield* flags.evaluate("mode", {})).toBe("saved")
              const rejected = yield* Effect.result(flags.set("mode", { value: false }))
              expect(
                Result.isFailure(rejected) && Schema.is(InvalidOverride)(rejected.failure),
              ).toBe(true)
              expect(yield* flags.evaluate("mode", {})).toBe("saved")
              const snapshot = yield* flags.snapshot({ userId: "alice" })
              expect(snapshot).toEqual({ mode: { value: "private" } })
              expect(evaluate(registry)("mode", {}, snapshot)).toBe("private")
              yield* flags.remove("mode")
              expect(yield* flags.evaluate("mode", {})).toBe("default")
              yield* flags.set("mode", { value: "must not leak" })
            }),
          ),
        )
      } finally {
        yield* Effect.promise(() => runtime.dispose())
      }
      const restarted = ManagedRuntime.make(layer.pipe(Layer.provide(memoryStore)))
      try {
        expect(
          yield* Effect.promise(() =>
            restarted.runPromise(Effect.flatMap(Flags, (flags) => flags.evaluate("mode", {}))),
          ),
        ).toBe("default")
      } finally {
        yield* Effect.promise(() => restarted.dispose())
      }
    }),
)

it.effect(
  "returns typed unknown errors for all dynamic-key operations without writing the store",
  () =>
    Effect.gen(function* () {
      const dynamic: DynamicRegistry = registry
      const service = makeFlags(dynamic)
      const runtime = ManagedRuntime.make(service.layer.pipe(Layer.provide(memoryStore)))
      try {
        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.gen(function* () {
              const flags = yield* service.Flags
              for (const operation of [
                flags.evaluate("missing", {}),
                flags.set("missing", { value: "x" }),
                flags.remove("missing"),
              ]) {
                const result = yield* Effect.result(operation)
                expect(Result.isFailure(result) && Schema.is(UnknownFlag)(result.failure)).toBe(
                  true,
                )
              }
            }),
          ),
        )
      } finally {
        yield* Effect.promise(() => runtime.dispose())
      }
    }),
)

it.effect("keeps store outages as typed failures instead of returning the default", () =>
  Effect.gen(function* () {
    const dynamic: DynamicRegistry = registry
    const service = makeFlags(dynamic)
    const failure = Effect.fail(StoreError.make({}))
    const broken = Layer.succeed(OverrideStore, {
      read: failure,
      set: () => failure,
      remove: () => failure,
    })
    const runtime = ManagedRuntime.make(service.layer.pipe(Layer.provide(broken)))
    try {
      const result = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(service.Flags, (flags) => flags.evaluate("mode", {})).pipe(Effect.result),
        ),
      )
      expect(Result.isFailure(result) && Schema.is(StoreError)(result.failure)).toBe(true)
      const unknown = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flatMap(service.Flags, (flags) => flags.evaluate("missing", {})).pipe(
            Effect.result,
          ),
        ),
      )
      expect(Result.isFailure(unknown) && Schema.is(UnknownFlag)(unknown.failure)).toBe(true)
    } finally {
      yield* Effect.promise(() => runtime.dispose())
    }
  }),
)
