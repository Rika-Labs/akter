import { Option } from "effect"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vitest"
import { workspace } from "../workspace/fixtures.ts"
import { ChangedPaletteQuery, FoundActors, OpenedPalette } from "./message.ts"
import type { Model } from "./model.ts"
import { paletteResults } from "./palette.ts"
import { init, update } from "./update.ts"

const open = (): Model => {
  const url = Option.getOrThrow(Url.fromString("http://localhost/actors"))
  const model = { ...init({ workspace, theme: "light" }, url).model, loading: false }
  return update(model, OpenedPalette()).model
}

const typed = (model: Model, query: string) => update(model, ChangedPaletteQuery({ query }))

const found = (model: Model) =>
  paletteResults(model)
    .filter((item) => item.group === "Actors")
    .map((item) => item.label)

describe("palette actor search", () => {
  it("searches the runtime for what is typed, and not for an empty query", () => {
    const searched = typed(open(), " Counter/ ")
    expect(searched.commands?.map((command) => command.name)).toEqual(["SearchActors"])
    expect(searched.commands?.[0]).toMatchObject({ args: { query: "Counter/" } })
    expect(typed(open(), "  ").commands ?? []).toEqual([])
  })

  it("offers found actors as links, without repeating a pinned one", () => {
    const pinned = workspace.pinned[0]
    if (pinned === undefined) throw new Error("The fixture workspace pins an actor")
    const model = typed(open(), "C").model
    const answered = update(
      model,
      FoundActors({ query: "C", actors: ["Counter/hits", `${pinned.actorType}/${pinned.key}`] }),
    ).model
    expect(found(answered)).toEqual(["Counter/hits"])
    const chosen = paletteResults(answered).find((item) => item.label === "Counter/hits")
    expect(chosen?.onSelect).toMatchObject({ href: "/actors/Counter/hits" })
  })

  it("keeps an earlier answer while the query narrows and drops one for a different query", () => {
    const answered = update(
      typed(open(), "Co").model,
      FoundActors({ query: "Co", actors: ["Counter/hits", "Collector/a"] }),
    ).model
    expect(found(typed(answered, "Cou").model)).toEqual(["Counter/hits"])
    expect(found(typed(answered, "Or").model)).toEqual([])
    const stale = update(
      typed(open(), "Or").model,
      FoundActors({ query: "Co", actors: ["Counter/hits"] }),
    ).model
    expect(found(stale)).toEqual([])
  })
})
