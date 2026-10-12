import { describe, expect, it } from "@effect/vitest"
import { JsonPatch, Schema } from "effect"
import { Draft } from "./draft.ts"

interface Row {
  id: number
  tags: Array<string>
}

interface Fixture {
  a: number
  s: string
  obj: { x: number; y: { z: Array<number> }; w: string }
  list: Array<Row>
  rec: Record<string, string>
}

const fixture = (): Fixture => ({
  a: 1,
  s: "x",
  obj: { x: 1, y: { z: [1, 2, 3] }, w: "q" },
  list: [
    { id: 1, tags: ["a"] },
    { id: 2, tags: [] },
    { id: 3, tags: ["b", "c"] },
  ],
  rec: { k1: "v1", k2: "v2" },
})

type Edit = (state: Fixture, draw: (bound: number) => number) => void

const edits: ReadonlyArray<Edit> = [
  (state, draw) => {
    state.a = draw(100)
  },
  (state) => {
    state.s += "y"
  },
  (state) => {
    state.obj.x++
  },
  (state, draw) => {
    state.obj.y.z.push(draw(10))
  },
  (state) => {
    state.obj.y.z.pop()
  },
  (state) => {
    state.obj.y = { z: [9] }
  },
  (state) => {
    state.obj.y.z.reverse()
  },
  (state, draw) => {
    state.list.push({ id: draw(1000), tags: [] })
  },
  (state, draw) => {
    state.list[draw(state.list.length)]?.tags.push(`t${draw(5)}`)
  },
  (state, draw) => {
    state.list.splice(draw(Math.max(1, state.list.length)), 1)
  },
  (state) => {
    state.list.sort((left, right) => left.id - right.id)
  },
  (state, draw) => {
    state.list.unshift({ id: draw(1000), tags: ["u"] })
  },
  (state, draw) => {
    state.rec[`k${draw(5)}`] = `v${draw(5)}`
  },
  (state, draw) => {
    delete state.rec[`k${draw(5)}`]
  },
  (state) => {
    state.list.length = Math.min(state.list.length, 2)
  },
  (state, draw) => {
    const last = state.list.at(-1)
    if (last !== undefined) last.id = draw(5)
  },
]

const aliasing: Edit = (state) => {
  const second = state.list[1]
  if (second !== undefined) state.list[0] = second
}

const isJsonObject = Schema.is(Schema.JsonObject)

const canonical = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([field, inner]) => [field, canonical(inner)]),
  )
}

const same = (left: Schema.Json, right: Schema.Json): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

const toJson = (state: Fixture): Schema.JsonObject => JSON.parse(JSON.stringify(state))

const fields = ["a", "s", "obj", "list", "rec"] as const

const lcg = (seed: number) => {
  let state = seed
  return (bound: number): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % Math.max(1, bound)
  }
}

interface Failures {
  value: number
  base: number
  changed: number
  patch: number
}

const fuzz = (seed: number, pool: ReadonlyArray<Edit>, rounds: number): Failures => {
  const draw = lcg(seed)
  const failures: Failures = { value: 0, base: 0, changed: 0, patch: 0 }
  for (let round = 0; round < rounds; round++) {
    const recipe = Array.from({ length: 1 + draw(6) }, () => pool[draw(pool.length)] ?? edits[0]!)
    const recipeSeed = draw(0x7fffffff)
    const replay = (state: Fixture) => {
      const local = lcg(recipeSeed)
      for (const edit of recipe) edit(state, local)
    }
    const base = fixture()
    const original = toJson(base)
    const session = Draft.begin(base)
    replay(session.draft)
    const out = session.finish()
    const oracle = structuredClone(fixture())
    replay(oracle)
    const next = toJson(out.value)
    if (!same(toJson(oracle), next)) failures.value++
    if (!same(toJson(base), original)) failures.base++
    const changed = fields.filter((field) => !Object.is(out.value[field], base[field]))
    if (changed.join() !== [...out.changed].join()) failures.changed++
    const ops = [...out.changed].flatMap((field) =>
      JsonPatch.get(original[field] ?? null, next[field] ?? null).map((op) => ({ ...op, path: `/${field}${op.path}` })),
    )
    if (!same(JsonPatch.apply(ops, original), next)) failures.patch++
  }
  return failures
}

describe("Draft", () => {
  it("matches plain JavaScript on a deep copy, never writes the base, and reports exactly the changed fields", () => {
    expect(fuzz(42, edits, 20_000)).toEqual({ value: 0, base: 0, changed: 0, patch: 0 })
  })

  it("keeps one object when a drafted value is aliased into another slot", () => {
    expect(fuzz(7, [...edits, aliasing, aliasing], 20_000)).toEqual({ value: 0, base: 0, changed: 0, patch: 0 })
  })

  it("shares untouched branches with the base and reports no change for a no-op recipe", () => {
    const base = fixture()
    const session = Draft.begin(base)
    session.draft.obj.y.z.push(4)
    const out = session.finish()
    expect([out.value.list === base.list, out.value.rec === base.rec, out.value.obj === base.obj]).toEqual([true, true, false])
    expect(out.value.obj.y.z).toEqual([1, 2, 3, 4])
    expect(base.obj.y.z).toEqual([1, 2, 3])
    expect([...out.changed]).toEqual(["obj"])
    const untouched = Draft.begin(fixture())
    void untouched.draft.list[0]?.tags.length
    const nothing = untouched.finish()
    expect([...nothing.changed]).toEqual([])
  })
})
