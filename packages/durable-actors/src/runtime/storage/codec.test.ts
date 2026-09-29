import { Effect, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { describe, expect, it } from "vitest"
import { ActorRef } from "../../identity/caller.ts"
import { checkProperty } from "../../testing/property.ts"
import { compress, decompress, PLACEMENT_ENCODING, routingKey } from "./codec.ts"

const ref = Arbitrary.schema(ActorRef)

const json = Arbitrary.schema(Schema.Json)

const golden = [
  {
    ref: { tenant: "acme", actor: "Counter", id: "c-1" },
    tenant: 2472398586103912953n,
    actor: -7568578567777114831n,
  },
  {
    ref: { tenant: "acme", actor: "Room", id: "général" },
    tenant: 2472398586103912953n,
    actor: 6840356835474622928n,
  },
  {
    ref: { tenant: "t\u0000n", actor: 'A"b', id: '["x",1]' },
    tenant: 2868321648467284951n,
    actor: -4555675029134783043n,
  },
  {
    ref: { tenant: "🙂", actor: "Feed", id: "" },
    tenant: 4426527016479877485n,
    actor: 7470525016518610251n,
  },
] as const

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("storage codec", () => {
  it("keeps routing keys on the golden vectors of placement encoding 1", () => {
    expect(PLACEMENT_ENCODING).toBe(1)

    for (const vector of golden) {
      expect(routingKey({ ref: vector.ref, placement: "tenant" })).toBe(vector.tenant)
      expect(routingKey({ ref: vector.ref, placement: "actor" })).toBe(vector.actor)
    }

    expect(BigInt.asIntN(64, Bun.hash.xxHash3('[1,"tenant","acme"]'))).toBe(golden[0].tenant)
    expect(BigInt.asIntN(64, Bun.hash.xxHash3('[1,"actor","acme","Counter","c-1"]'))).toBe(
      golden[0].actor,
    )
  })

  it("gives a parent-placed child and grandchild their root's routing key", () => {
    const order = { tenant: "acme", actor: "Order", id: "o-17" }
    const shipment = { parent: "Order", placement: "actor" } as const
    const label = { parent: "Shipment", placement: shipment } as const
    const root = -7799243039352196172n

    expect(BigInt.asIntN(64, Bun.hash.xxHash3('[1,"actor","acme","Order","o-17"]'))).toBe(root)
    expect(routingKey({ ref: order, placement: "actor" })).toBe(root)
    expect(
      routingKey({
        ref: { tenant: "acme", actor: "Shipment", id: "c1.4.o-17.pkg-1" },
        placement: shipment,
      }),
    ).toBe(root)
    expect(
      routingKey({
        ref: { tenant: "acme", actor: "Label", id: "c1.15.c1.4.o-17.pkg-1.label-1" },
        placement: label,
      }),
    ).toBe(root)
    expect(
      routingKey({
        ref: { tenant: "acme", actor: "Shipment", id: "c1.4.o-18.pkg-1" },
        placement: shipment,
      }),
    ).not.toBe(root)
    expect(() =>
      routingKey({ ref: { tenant: "acme", actor: "Shipment", id: "pkg-1" }, placement: shipment }),
    ).toThrow("carries no Order parent id")
  })

  it("derives a stable signed 64-bit routing key that tenant placement shares across a tenant", () =>
    run(
      checkProperty({
        name: "routing key stability",
        arbitrary: Arbitrary.all([ref, ref]),
        property: ([a, b]) => {
          const tenant = routingKey({ ref: a, placement: "tenant" })
          const actor = routingKey({ ref: a, placement: "actor" })
          const sibling = { tenant: a.tenant, actor: b.actor, id: b.id }

          return (
            tenant === routingKey({ ref: { ...a }, placement: "tenant" }) &&
            actor === routingKey({ ref: { ...a }, placement: "actor" }) &&
            BigInt.asIntN(64, tenant) === tenant &&
            BigInt.asIntN(64, actor) === actor &&
            routingKey({ ref: sibling, placement: "tenant" }) === tenant &&
            tenant ===
              BigInt.asIntN(
                64,
                Bun.hash.xxHash3(JSON.stringify([PLACEMENT_ENCODING, "tenant", a.tenant])),
              ) &&
            actor ===
              BigInt.asIntN(
                64,
                Bun.hash.xxHash3(
                  JSON.stringify([PLACEMENT_ENCODING, "actor", a.tenant, a.actor, a.id]),
                ),
              )
          )
        },
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))

  it("round-trips encoded state values through compression", () =>
    run(
      checkProperty({
        name: "state codec round-trip",
        arbitrary: json,
        property: (value) => {
          const encoded = JSON.stringify(value)
          const stored = compress(encoded)
          const decoded = decompress(stored)

          return (
            decoded === encoded &&
            JSON.stringify(JSON.parse(decoded)) === encoded &&
            decompress(compress(decoded)) === encoded
          )
        },
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))
})
