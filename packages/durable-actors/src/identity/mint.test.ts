import { BunCrypto } from "@effect/platform-bun"
import { type Crypto, Effect, ManagedRuntime, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ActorRef, System } from "./caller.ts"
import { deriveMintId, isMintedId, mintPreimage, provesMint } from "./mint.ts"

const commandId = "v1.1767225600000.1767312000000.0190a3b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b"

const parent = ActorRef.make({ tenant: "acme", actor: "Planner", id: "p1" })

const runtime = ManagedRuntime.make(BunCrypto.layer)

const run = <A>(effect: Effect.Effect<A, never, Crypto.Crypto>) => runtime.runPromise(effect)

describe("minted actor ids", () => {
  it("matches fixed vectors", () =>
    run(
      Effect.gen(function* () {
        const vectors: ReadonlyArray<readonly [Parameters<typeof deriveMintId>[0], string]> = [
          [
            { parent, commandId, ordinal: 0, child: "Task" },
            "0c5a337c-0560-8eb1-b010-902d673172c7",
          ],
          [
            { parent, commandId, ordinal: 1, child: "Task" },
            "3ae6ebfe-9609-8687-b75b-9e198d77fb9f",
          ],
          [
            { parent, commandId, ordinal: 0, child: "Note" },
            "fe9dbb44-85a2-8877-acb9-6831a50179ef",
          ],
          [
            { parent: { ...parent, tenant: "other" }, commandId, ordinal: 0, child: "Task" },
            "aa018c3d-8a57-8020-928d-3dcdf7f18354",
          ],
          [
            { parent: { ...parent, id: "p2" }, commandId, ordinal: 0, child: "Task" },
            "6aed5848-79c2-8c75-87c9-9a1c1f0b362c",
          ],
          [
            {
              parent: { tenant: "acme", actor: "Café", id: "" },
              commandId,
              ordinal: 0,
              child: "Task",
            },
            "d30d3458-a1b1-89ad-af2e-945f0d48a9f1",
          ],
        ]

        for (const [input, id] of vectors) {
          const derived = yield* deriveMintId(input)
          expect(derived).toBe(id)
          expect(isMintedId(derived)).toBe(true)
          expect(Schema.is(Schema.String.check(Schema.isUUID(8)))(derived)).toBe(true)
        }
      }),
    ))

  it("length-prefixes every field so adjacent fields cannot shift into each other", () => {
    const a = mintPreimage({ parent: { ...parent, id: "ab" }, commandId, ordinal: 0, child: "c" })
    const b = mintPreimage({ parent: { ...parent, id: "a" }, commandId, ordinal: 0, child: "bc" })
    expect(a).not.toEqual(b)
    expect(
      Array.from(mintPreimage({ parent, commandId, ordinal: 0, child: "T" }).slice(0, 4)),
    ).toEqual([0, 0, 0, 22])
  })

  it("accepts only the System caller whose mint proof derives the target id", () =>
    run(
      Effect.gen(function* () {
        const id = yield* deriveMintId({ parent, commandId, ordinal: 0, child: "Task" })
        const target = ActorRef.make({ tenant: "acme", actor: "Task", id })
        const proof = { commandId, ordinal: 0 }

        const proves = (caller: Parameters<typeof provesMint>[0]) => provesMint(caller, target)

        expect(yield* proves(System.make({ source: "actor", ref: parent, mint: proof }))).toBe(true)
        expect(yield* proves(System.make({ source: "timer", ref: parent, mint: proof }))).toBe(true)
        expect(yield* proves(System.make({ source: "actor", ref: parent }))).toBe(false)
        expect(
          yield* proves(
            System.make({ source: "actor", ref: parent, mint: { commandId, ordinal: 1 } }),
          ),
        ).toBe(false)
        expect(
          yield* proves(
            System.make({ source: "actor", ref: { ...parent, id: "p2" }, mint: proof }),
          ),
        ).toBe(false)
        expect(yield* proves(System.make({ source: "effect", ref: parent, mint: proof }))).toBe(
          false,
        )
      }),
    ))
})
