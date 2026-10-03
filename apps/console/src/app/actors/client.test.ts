import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadActor, loadActorType, loadActors } from "./client.ts"
import { ActorPage, ActorsPage, ActorTypePage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("actors client in fixture mode", () => {
  it("serves types, one type with its instances and an inspector, and nothing for an unknown name", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const actors = yield* loadActors
        expect(Schema.is(ActorsPage)(actors)).toBe(true)
        expect(actors.types).toHaveLength(8)
        const order = yield* loadActorType("Order")
        expect(Schema.is(ActorTypePage)(order)).toBe(true)
        expect(order?.instances.map((instance) => instance.key)).toContain("ord_9a01")
        expect(order?.activity?.perSecond).toHaveLength(96)
        const inspected = yield* loadActor({ actorType: "Order", key: "ord_9a01" })
        expect(Schema.is(ActorPage)(inspected)).toBe(true)
        expect(inspected).toMatchObject({ actorType: "Order", key: "ord_9a01" })
        expect(yield* loadActorType("Nope")).toBeUndefined()
        expect(yield* loadActor({ actorType: "Nope", key: "x" })).toBeUndefined()
      }),
    ))
})
