import { BunCrypto } from "@effect/platform-bun"
import { Crypto, Effect, ManagedRuntime, Predicate, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { describe, expect, it } from "vitest"
import { User } from "../../identity/caller.ts"
import { Outcome } from "../request.ts"
import { checkProperty } from "../../testing/property.ts"
import { checkReceipt, encodeOutcome, hashCanonical } from "./receipt.ts"

const Stored = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.String }),
  Schema.TaggedStruct("Failure", { value: Schema.String }),
])

const Differences = Schema.Struct({
  caller: Schema.Boolean,
  command: Schema.Boolean,
  payload: Schema.Boolean,
})

/** Strings that survive a UTF-8 round trip: Postgres never emits lone surrogates in JSONB text, and UTF-8 cannot encode them. */
const jsonbText = Arbitrary.filter(
  Arbitrary.schema(Schema.String),
  (value) => new TextDecoder().decode(new TextEncoder().encode(value)) === value,
)

const runtime = ManagedRuntime.make(BunCrypto.layer)

const run = <A>(effect: Effect.Effect<A, never, Crypto.Crypto>) => runtime.runPromise(effect)

describe("receipts", () => {
  it("hashes a canonical payload stably and distinctly", () =>
    run(
      checkProperty({
        name: "canonical payload hash stability",
        arbitrary: Arbitrary.all([jsonbText, jsonbText]),
        property: Effect.fnUntraced(function* ([a, b]) {
          const hash = yield* hashCanonical(a)

          return (
            /^[0-9a-f]{64}$/.test(hash) &&
            hash === (yield* hashCanonical(a)) &&
            (hash === (yield* hashCanonical(b))) === (a === b)
          )
        }),
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))

  it("replays a stored outcome exactly and refuses a changed caller, command, or payload", () =>
    run(
      checkProperty({
        name: "receipt encode, decode, and replay",
        arbitrary: Arbitrary.all([
          Arbitrary.schema(Stored),
          Arbitrary.schema(Schema.String),
          Arbitrary.schema(Differences),
        ]),
        property: Effect.fnUntraced(function* ([stored, payload, differs]) {
          const outcome = Outcome.cases[stored._tag].make({ value: stored.value })

          const request = {
            ref: { tenant: "t", actor: "Counter", id: "1" },
            caller: User.make({ subject: "alice" }),
            command: "Increment",
            commandId: "v1.1000.6000.17b3670b-3f17-4a9b-aade-037e1dd1bba8",
            payload,
          }

          const hash = yield* hashCanonical(payload)

          const receipt = {
            caller_key: differs.caller ? '["User","bob"]' : '["User","alice"]',
            command: differs.command ? "Reject" : "Increment",
            payload_hash: differs.payload ? yield* hashCanonical(`${payload}!`) : hash,
            outcome: yield* encodeOutcome(outcome).pipe(Effect.orDie),
          }

          const replayed = yield* checkReceipt(request, hash, receipt).pipe(
            Effect.map((decoded) => ({ _tag: "Replayed" as const, decoded })),
            Effect.catch((error) => Effect.succeed({ _tag: error.reason._tag })),
          )

          if (differs.caller) return Predicate.isTagged(replayed, "Unauthorized")

          if (differs.command || differs.payload)
            return Predicate.isTagged(replayed, "CommandConflict")

          return (
            "decoded" in replayed &&
            Predicate.isTagged(replayed.decoded, outcome._tag) &&
            Schema.toEquivalence(Stored)(replayed.decoded as typeof Stored.Type, stored)
          )
        }),
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))
})
