import { Effect, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { describe, expect, it } from "vitest"
import { checkProperty } from "../testing/property.ts"
import { CommandId, commandTimes, connectionCommandId } from "./command.ts"
import { Anonymous, callerKey, User } from "./caller.ts"

describe("command identity", () => {
  const id = "v1.1000.6000.17b3670b-3f17-4a9b-aade-037e1dd1bba8"
  it("binds both times into one canonical identity", () => {
    expect(commandTimes(id)).toEqual({ issuedAt: 1000, expiresAt: 6000 })

    for (const invalid of [
      id.replace("v1", "v2"),
      id.replace("1000", "01000"),
      `${id}.extra`,
      id.toUpperCase(),
    ]) {
      expect(Schema.is(CommandId)(invalid)).toBe(false)
    }
  })
  it("uses logical subjects, not credentials or ambiguous string concatenation", () => {
    expect(callerKey(User.make({ subject: "alice" }))).toBe(
      callerKey(User.make({ subject: "alice" })),
    )
    expect(callerKey(User.make({ subject: "Anonymous" }))).not.toBe(callerKey(Anonymous.make({})))
    expect(callerKey(User.make({ subject: "alice" }))).not.toBe(
      callerKey(User.make({ subject: "bob" })),
    )
  })
})

const Nibble = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))

const Millis = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999_999 }))

const uuid = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.array(Arbitrary.schema(Nibble), { minLength: 30, maxLength: 30 }),
    Arbitrary.schema(Schema.Literals(["8", "9", "a", "b"])),
  ]),
  ([nibbles, variant]) => {
    const hex = nibbles.map((n) => n.toString(16)).join("")

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-${variant}${hex.slice(15, 18)}-${hex.slice(18, 30)}`
  },
)

const Mutation = Schema.Literals([
  "version",
  "leadingZero",
  "negative",
  "extra",
  "missing",
  "uppercase",
  "uuidVersion",
  "nul",
  "whitespace",
])

const mutate = (id: string, mutation: typeof Mutation.Type): string => {
  const [version, issuedAt, expiresAt, rest] = id.split(".") as [string, string, string, string]

  switch (mutation) {
    case "version":
      return `v2.${issuedAt}.${expiresAt}.${rest}`
    case "leadingZero":
      return `${version}.0${issuedAt}.${expiresAt}.${rest}`
    case "negative":
      return `${version}.-${issuedAt}.${expiresAt}.${rest}`
    case "extra":
      return `${id}.1`
    case "missing":
      return `${version}.${issuedAt}.${rest}`
    case "uppercase":
      return `${version}.${issuedAt}.${expiresAt}.${rest.toUpperCase().replace(/^[0-9-]*$/, "G")}`
    case "uuidVersion":
      return `${version}.${issuedAt}.${expiresAt}.${rest.slice(0, 14)}5${rest.slice(15)}`
    case "nul":
      return `${id}\u0000`
    case "whitespace":
      return ` ${id}`
  }
}

const Subject = Schema.Literals(["alice", "User", "Anonymous", '["User","alice"]', "a,b"])

const SmallRef = Schema.Struct({
  tenant: Schema.Literals(["t", "t,a"]),
  actor: Schema.Literals(["a", "Counter"]),
  id: Schema.Literals(["1", "alice"]),
})

const SmallCaller = Schema.Union([
  Schema.TaggedStruct("User", { subject: Subject }),
  Schema.TaggedStruct("Anonymous", {}),
  Schema.TaggedStruct("System", {
    source: Schema.Literals(["actor", "timer"]),
    ref: Schema.optionalKey(SmallRef),
    onBehalfOf: Schema.optionalKey(Schema.Struct({ subject: Subject })),
    mint: Schema.optionalKey(
      Schema.Struct({ commandId: Schema.Literals(["a", "b"]), ordinal: Schema.Literals([0, 1]) }),
    ),
  }),
])

const sameCaller = Schema.toEquivalence(SmallCaller)

describe("command identity properties", () => {
  it("formats and parses every canonical id and rejects every non-canonical variant", () =>
    Effect.runPromise(
      checkProperty({
        name: "command id parse and format",
        arbitrary: Arbitrary.all([
          Arbitrary.schema(Millis),
          Arbitrary.schema(Millis),
          uuid,
          Arbitrary.schema(Mutation),
        ]),
        property: ([issuedAt, expiresAt, id, mutation]) => {
          const commandId = `v1.${issuedAt}.${expiresAt}.${id}`
          const mutated = mutate(commandId, mutation)

          return (
            Schema.is(CommandId)(commandId) &&
            commandTimes(commandId).issuedAt === issuedAt &&
            commandTimes(commandId).expiresAt === expiresAt &&
            `v1.${commandTimes(commandId).issuedAt}.${commandTimes(commandId).expiresAt}.${id}` ===
              commandId &&
            !Schema.is(CommandId)(mutated)
          )
        },
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))

  it("keys two callers the same exactly when they are the same logical caller", () => {
    const caller = Arbitrary.schema(SmallCaller)

    return Effect.runPromise(
      checkProperty({
        name: "caller key injectivity",
        arbitrary: Arbitrary.all([caller, caller]),
        property: ([a, b]) => {
          const key = callerKey(a)

          return (
            key === callerKey(structuredClone(a)) && (key === callerKey(b)) === sameCaller(a, b)
          )
        },
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    )
  })
})

describe("connection command ids", () => {
  const commands = { secret: "ab".repeat(32), seq: 3, issuedAt: 1000, expiresAt: 6000 }

  it("are stable for one call and distinct across seq, index, target, command, and secret", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = (overrides: Partial<typeof commands>, index = 0, target = "t", command = "C") =>
          connectionCommandId({ commands: { ...commands, ...overrides }, index, target, command })

        const first = yield* id({})
        expect(yield* id({})).toBe(first)
        expect(Schema.is(CommandId)(first)).toBe(true)
        expect(commandTimes(first)).toEqual({ issuedAt: 1000, expiresAt: 6000 })

        const others = [
          yield* id({ seq: 4 }),
          yield* id({}, 1),
          yield* id({}, 0, "u"),
          yield* id({}, 0, "t", "D"),
          yield* id({ secret: "cd".repeat(32) }),
        ]

        expect(new Set([first, ...others]).size).toBe(6)
      }),
    ))
})
