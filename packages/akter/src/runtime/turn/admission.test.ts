import { Effect, Exit, Schema } from "effect"
import { Arbitrary } from "effect"
import { describe, expect, it } from "vitest"
import { checkProperty } from "../../testing/property.ts"
import { checkIdentity } from "./admission.ts"

const Issued = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 999_000_000_000_000 }))

const Window = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_000_000_000 }))

const uuid = "17b3670b-3f17-4a9b-aade-037e1dd1bba8"

const outcome = (id: string, window: number, now: number) =>
  checkIdentity(id, window, now).pipe(
    Effect.map(() => "Admitted"),
    Effect.catch((error) => Effect.succeed(error.reason._tag)),
  )

describe("command expiry", () => {
  it("admits a command until the millisecond it expires and never before it was issued", () =>
    Effect.runPromise(
      checkProperty({
        name: "command expiry boundary",
        arbitrary: Arbitrary.all([Arbitrary.schema(Issued), Arbitrary.schema(Window)]),
        property: Effect.fnUntraced(function* ([issuedAt, window]) {
          const expiresAt = issuedAt + window
          const id = `v1.${issuedAt}.${expiresAt}.${uuid}`
          const at = (now: number) => outcome(id, window, now)

          return (
            (yield* at(issuedAt)) === "Admitted" &&
            (yield* at(expiresAt - 1)) === "Admitted" &&
            (yield* at(expiresAt)) === "CommandExpired" &&
            (yield* at(expiresAt + 1)) === "CommandExpired" &&
            (yield* at(issuedAt - 1)) === "InvalidCommandId" &&
            (yield* outcome(id, window + 1, issuedAt)) === "InvalidCommandId" &&
            Exit.isSuccess(yield* Effect.exit(checkIdentity(id, window, expiresAt - 1)))
          )
        }),
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))
})
