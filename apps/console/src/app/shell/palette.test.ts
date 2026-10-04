import { Option } from "effect"
import * as Url from "foldkit/url"
import { describe, expect, it } from "vitest"
import { workspace } from "../workspace/fixtures.ts"
import {
  ChangedPaletteQuery,
  FoundActors,
  MovedPaletteSelection,
  OpenedPalette,
  SettledPaletteQuery,
} from "./message.ts"
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
  it("searches the runtime once the typed query settles, and not for an empty query", () => {
    const typing = typed(open(), " Counter/ ")
    expect(typing.commands?.map((command) => command.name)).toEqual(["SettlePaletteQuery"])
    expect(typing.commands?.[0]).toMatchObject({ args: { query: "Counter/" } })
    const settled = update(typing.model, SettledPaletteQuery({ query: "Counter/" }))
    expect(settled.commands?.map((command) => command.name)).toEqual(["SearchActors"])
    expect(settled.commands?.[0]).toMatchObject({ args: { query: "Counter/" } })
    expect(typed(open(), "  ").commands ?? []).toEqual([])
  })

  it("skips the search for a query the person has already typed past", () => {
    const typing = typed(typed(open(), "Co").model, "Cou").model
    expect(update(typing, SettledPaletteQuery({ query: "Co" })).commands ?? []).toEqual([])
  })

  it("ignores an answer to a shorter query than the one already answered", () => {
    const longer = update(
      typed(open(), "Coun").model,
      FoundActors({ query: "Coun", actorTypes: [], actors: ["Counter/hits"] }),
    ).model
    const stale = update(
      longer,
      FoundActors({ query: "Co", actorTypes: [], actors: ["Collector/a", "Counter/hits"] }),
    ).model
    expect(stale.palette.found?.query).toBe("Coun")
    expect(found(stale)).toEqual(["Counter/hits"])
  })

  it("keeps a moved highlight the new answer still holds and drops one it no longer does", () => {
    const first = update(
      typed(open(), "Co").model,
      FoundActors({ query: "Co", actorTypes: [], actors: ["Collector/a", "Counter/hits"] }),
    ).model
    const moved = { ...first, palette: { ...first.palette, active: "found-Collector/a" } }
    expect(paletteResults(moved)[0]?.id).not.toBe("found-Collector/a")
    const kept = update(
      moved,
      FoundActors({ query: "Co", actorTypes: [], actors: ["Collector/a", "Counter/hits"] }),
    ).model
    expect(kept.palette.active).toBe("found-Collector/a")
    const dropped = update(
      moved,
      FoundActors({ query: "Co", actorTypes: [], actors: ["Counter/hits"] }),
    ).model
    expect(dropped.palette.active).toBe(paletteResults(dropped)[0]?.id)
    expect(dropped.palette.active).not.toBe("found-Collector/a")
  })

  it("offers found actors as links, without repeating a pinned one", () => {
    const pinned = workspace.pinned[0]
    if (pinned === undefined) throw new Error("The fixture workspace pins an actor")
    const model = typed(open(), "C").model
    const answered = update(
      model,
      FoundActors({
        query: "C",
        actorTypes: [],
        actors: ["Counter/hits", `${pinned.actorType}/${pinned.key}`],
      }),
    ).model
    expect(found(answered)).toEqual(["Counter/hits"])
    const chosen = paletteResults(answered).find((item) => item.label === "Counter/hits")
    expect(chosen?.onSelect).toMatchObject({ href: "/actors/Counter/hits" })
  })

  it("keeps an earlier answer while the query narrows and drops one for a different query", () => {
    const answered = update(
      typed(open(), "Co").model,
      FoundActors({ query: "Co", actorTypes: [], actors: ["Counter/hits", "Collector/a"] }),
    ).model
    expect(found(typed(answered, "Cou").model)).toEqual(["Counter/hits"])
    expect(found(typed(answered, "Or").model)).toEqual([])
    const stale = update(
      typed(open(), "Or").model,
      FoundActors({ query: "Co", actorTypes: [], actors: ["Counter/hits"] }),
    ).model
    expect(found(stale)).toEqual([])
  })

  it("offers found actor types ahead of found actors, linking to the type page", () => {
    const answered = update(
      typed(open(), "Co").model,
      FoundActors({ query: "Co", actorTypes: ["Counter"], actors: ["Counter/hits"] }),
    ).model
    const runtime = paletteResults(answered).filter(
      (item) => item.group === "Actor types" || item.group === "Actors",
    )
    expect(runtime.map((item) => [item.group, item.label])).toEqual([
      ["Actor types", "Counter"],
      ["Actors", "Counter/hits"],
    ])
    expect(runtime[0]?.onSelect).toMatchObject({ href: "/actors/Counter" })
  })

  it("highlights the best result once the search answers, unless the person moved the selection", () => {
    const typedCo = typed(open(), "Le").model
    const answer = FoundActors({ query: "Le", actorTypes: ["Ledger"], actors: ["Ledger/books"] })
    expect(update(typedCo, answer).model.palette.active).toBe("type-Ledger")
    const moved = update(typedCo, MovedPaletteSelection({ step: 1 })).model
    expect(update(moved, answer).model.palette.active).toBe(moved.palette.active)
  })
})
