import { BunServices } from "@effect/platform-bun"
import { it as effectIt } from "@effect/vitest"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  bucket,
  evaluate,
  flag,
  InvalidOverride,
  UnknownFlag,
  validateOverride,
} from "./evaluation.ts"
import type { Override } from "./evaluation.ts"

interface DynamicRegistry {
  readonly [key: string]: typeof registry.mode
}

const registry = {
  mode: flag(Schema.String)("default"),
  enabled: flag(Schema.Boolean)(false),
  limit: flag(Schema.Finite)(17),
  nullable: flag(Schema.NullOr(Schema.String))("default"),
}

describe("evaluation", () => {
  effectIt.effect("keeps rollout assignment across two fresh OS processes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(BunServices.layer)
        const output = Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const script = `import { bucket } from ${Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.String))(new URL("./evaluation.ts", import.meta.url).href))}; console.log(bucket("mode")({ userId: "alice" }))`
          const process = yield* spawner.spawn(ChildProcess.make("bun", ["--eval", script]))
          const result = yield* process.stdout.pipe(Stream.decodeText, Stream.mkString)
          expect(yield* process.exitCode).toBe(0)
          return result.trim()
        }).pipe(Effect.provideContext(context))
        expect(yield* output).toBe("791")
        expect(yield* output).toBe("791")
      }),
    ),
  )

  it("preserves schema-inferred types and defaults instead of assuming boolean flags", () => {
    expectTypeOf(evaluate(registry)("limit", {})).toEqualTypeOf<number>()
    expectTypeOf(evaluate(registry)("enabled", {})).toEqualTypeOf<boolean>()
    expect(evaluate(registry)("limit", {})).toBe(17)
    expect(evaluate(registry)("enabled", {})).toBe(false)
    expect(() => flag(Schema.Finite.check(Schema.isGreaterThan(0)))(-1)).toThrow()
  })

  it("orders user, organization, rollout, global and default without treating false or null as absent", () => {
    const rule: Override = {
      users: { alice: "user" },
      organizations: { acme: "organization" },
      rollout: { percentage: 100, value: "rollout" },
      value: "global",
    }
    expect(
      evaluate(registry)("mode", { userId: "alice", organizationId: "acme" }, { mode: rule }),
    ).toBe("user")
    expect(
      evaluate(registry)("mode", { userId: "bob", organizationId: "acme" }, { mode: rule }),
    ).toBe("organization")
    expect(evaluate(registry)("mode", { organizationId: "other" }, { mode: rule })).toBe("rollout")
    expect(evaluate(registry)("mode", {}, { mode: rule })).toBe("global")
    expect(evaluate(registry)("mode", {}, { mode: {} })).toBe("default")
    expect(
      evaluate(registry)(
        "enabled",
        { userId: "alice" },
        { enabled: { users: { alice: false }, value: true } },
      ),
    ).toBe(false)
    expect(evaluate(registry)("nullable", {}, { nullable: { value: null } })).toBeNull()
    expect(evaluate(registry)("mode", { userId: "toString" }, { mode: rule })).toBe("rollout")
  })

  it("uses fixed independent FNV vectors and strict percentage boundaries with identity namespaces", () => {
    expect(bucket("mode")({ userId: "alice" })).toBe(791)
    expect(bucket("mode")({ userId: "bob" })).toBe(944)
    expect(bucket("mode")({ organizationId: "acme" })).toBe(1013)
    expect(bucket("mode")({ userId: "ümlaut" })).toBe(5182)
    expect(bucket("mode2")({ userId: "alice" })).toBe(8759)
    expect(bucket("mode")({ userId: "alice", organizationId: "acme" })).toBe(791)
    expect(bucket("mode")({})).toBeUndefined()
    const check = (percentage: number) =>
      evaluate(registry)(
        "mode",
        { userId: "alice" },
        {
          mode: { rollout: { percentage, value: "in" }, value: "out" },
        },
      )
    expect(check(0)).toBe("out")
    expect(check(7.91)).toBe("out")
    expect(check(7.92)).toBe("in")
    expect(check(100)).toBe("in")
  })

  it("rejects unknown and inherited flags and every invalid rule, including non-selected targets", () => {
    const dynamic: DynamicRegistry = { mode: registry.mode }
    expect(() => evaluate(dynamic)("missing", {})).toThrow(UnknownFlag)
    expect(() => evaluate(dynamic)("toString", {})).toThrow(UnknownFlag)
    expect(() => validateOverride(dynamic)("missing", {})).toThrow(UnknownFlag)
    for (const percentage of [-1, 101, NaN, Infinity]) {
      expect(() =>
        validateOverride(registry)("mode", { rollout: { percentage, value: "in" } }),
      ).toThrow(InvalidOverride)
    }
    expect(() => evaluate(registry)("mode", {}, { mode: { users: { other: false } } })).toThrow(
      InvalidOverride,
    )
    expect(evaluate(registry)("mode", {}, { retired: { value: false } })).toBe("default")
  })

  it("round trips API snapshots through the wire schema for browser evaluation", () => {
    const wire = Schema.fromJsonString(
      Schema.Record(Schema.String, Schema.Struct({ value: Schema.Json })),
    )
    const encoded = Result.getOrThrow(
      Schema.encodeResult(wire)({ limit: { value: 23 }, enabled: { value: false } }),
    )
    const snapshot = Result.getOrThrow(Schema.decodeResult(wire)(encoded))
    expect(evaluate(registry)("limit", {}, snapshot)).toBe(23)
    expect(evaluate(registry)("enabled", {}, snapshot)).toBe(false)
  })
})
