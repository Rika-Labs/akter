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
        expect(actors.sample).toBe(true)
        expect(Schema.is(ActorsPage)(actors.data)).toBe(true)
        expect(actors.data.types).toHaveLength(8)
        const order = yield* loadActorType("Order")
        expect(order.sample).toBe(true)
        expect(Schema.is(ActorTypePage)(order.data)).toBe(true)
        expect(order.data?.instances.map((instance) => instance.key)).toContain("ord_9a01")
        expect(order.data?.activity?.perSecond).toHaveLength(96)
        const inspected = yield* loadActor({ actorType: "Order", key: "ord_9a01" })
        expect(inspected.sample).toBe(true)
        expect(Schema.is(ActorPage)(inspected.data)).toBe(true)
        expect(inspected.data).toMatchObject({ actorType: "Order", key: "ord_9a01" })
        expect((yield* loadActorType("Nope")).data).toBeUndefined()
        expect((yield* loadActor({ actorType: "Nope", key: "x" })).data).toBeUndefined()
      }),
    ))
})
