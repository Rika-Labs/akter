import { Effect, Schema } from "effect"
import { Arbitrary } from "effect/unstable/arbitrary"
import { describe, expect, it } from "vitest"
import { checkProperty } from "../testing/property.ts"
import { childId, parseChildId } from "./child.ts"

const wellFormed = Schema.makeFilter((value: string) => value.isWellFormed())

const part = Arbitrary.schema(Schema.String.check(wellFormed))

describe("child actor ids", () => {
  it("prefixes the parent id with its UTF-8 byte length", () => {
    expect(childId({ parent: "o-17", local: "pkg-1" })).toBe("c1.4.o-17.pkg-1")
    expect(childId({ parent: "c1.4.o-17.pkg-1", local: "label-1" })).toBe(
      "c1.15.c1.4.o-17.pkg-1.label-1",
    )
    expect(childId({ parent: "général", local: "x" })).toBe("c1.9.général.x")
    expect(parseChildId("c1.15.c1.4.o-17.pkg-1.label-1")).toEqual({
      parent: "c1.4.o-17.pkg-1",
      local: "label-1",
    })
    expect(parseChildId("c1.9.général.x")).toEqual({ parent: "général", local: "x" })
    expect(childId({ parent: "o-17", local: "" })).toBe("c1.4.o-17.")
    expect(parseChildId("c1.4.o-17.")).toEqual({ parent: "o-17", local: "" })
    expect(childId({ parent: "", local: "pkg-1" })).toBe("c1.0..pkg-1")
    expect(parseChildId("c1.0..pkg-1")).toEqual({ parent: "", local: "pkg-1" })
  })

  it("rejects every malformed form", () => {
    for (const id of [
      "o-17",
      "c1.",
      "c1.4",
      "c1.4.o-17",
      "c1.4.o-17x.pkg-1",
      "c1.5.o-17.pkg-1",
      "c1.04.o-17.pkg-1",
      "c2.4.o-17.pkg-1",
      "c1.x.o-17.pkg-1",
      "c1.1.é.x",
      "c1.99999999999.o-17.pkg-1",
      "c1.3.\ud800.x",
    ])
      expect(parseChildId(id)).toBeUndefined()
  })

  it("parses every child id back to its parts", () =>
    Effect.runPromise(
      checkProperty({
        name: "child id round-trip",
        arbitrary: Arbitrary.all([part, part]),
        property: ([parent, local]) => {
          const parsed = parseChildId(childId({ parent, local }))

          return parsed?.parent === parent && parsed.local === local
        },
      }).pipe(Effect.map((runs) => expect(runs).toBe(1_000))),
    ))
})
