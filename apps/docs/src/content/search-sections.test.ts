import { describe, expect, it, vi } from "vitest"

import { loadSearchSections, searchSections } from "./search-sections.ts"

const compiled = vi.hoisted(() => {
  const strings: Array<string> = []

  globalThis.Function = new Proxy(globalThis.Function, {
    construct: (target, args, newTarget) => {
      strings.push(args.join(","))

      return Reflect.construct(target, args, newTarget)
    },
  })

  return strings
})

const page = {
  url: "/guides/deploy",
  toc: [
    { url: "#build", depth: 2 },
    { url: "#target", depth: 3 },
    { url: "#region", depth: 3 },
    { url: "#run", depth: 2 },
    { url: "#logs", depth: 3 },
  ],
  structuredData: {
    headings: [
      { id: "build", content: "Build" },
      { id: "target", content: "Target" },
      { id: "region", content: "Region" },
      { id: "run", content: "Run" },
      { id: "logs", content: "Logs" },
    ],
    contents: [
      { heading: undefined, content: "How to ship." },
      { heading: "target", content: "Pick one." },
      { heading: "target", content: "Then confirm." },
      { heading: "run", content: "Start it." },
      { heading: "logs", content: "Read them." },
    ],
  },
}

describe("searchSections", () => {
  const sections = searchSections([page])

  it("names the heading above each section by the outline, not by the previous heading", () => {
    expect(sections["/guides/deploy#build"]?.parent).toBeUndefined()
    expect(sections["/guides/deploy#target"]?.parent).toBe("Build")
    expect(sections["/guides/deploy#region"]?.parent).toBe("Build")
    expect(sections["/guides/deploy#run"]?.parent).toBeUndefined()
    expect(sections["/guides/deploy#logs"]?.parent).toBe("Run")
  })

  it("keeps the first paragraph under a heading and none for a heading without text", () => {
    expect(sections["/guides/deploy#target"]?.text).toBe("Pick one.")
    expect(sections["/guides/deploy#build"]?.text).toBeUndefined()
    expect(sections["/guides/deploy#run"]?.text).toBe("Start it.")
  })

  it("keys each section by the page address and the heading's anchor", () => {
    expect(Object.keys(sections)).toEqual([
      "/guides/deploy#build",
      "/guides/deploy#target",
      "/guides/deploy#region",
      "/guides/deploy#run",
      "/guides/deploy#logs",
    ])
    expect(sections["/guides/deploy#region"]?.title).toBe("Region")
  })
})

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json }

describe("loadSearchSections", () => {
  const file = (body: () => Promise<Json>, ok = true) => ({ ok, json: body })
  const load = (body: Json, ok = true) =>
    loadSearchSections(() => Promise.resolve(file(() => Promise.resolve(body), ok)))

  it("asks the page's own origin for the file and reads back what the build wrote", async () => {
    const asked: Array<string> = []
    const written: Json = JSON.parse(JSON.stringify(searchSections([page])))
    const sections = await loadSearchSections((address) => {
      asked.push(address)

      return Promise.resolve(file(() => Promise.resolve(written)))
    })

    expect(asked).toEqual(["/search-sections.json"])
    expect(sections.size).toBe(5)
    expect(sections.get("/guides/deploy#target")).toEqual({
      title: "Target",
      parent: "Build",
      text: "Pick one.",
    })
  })

  it("gives no sections, and does not fail, for a file that says null", async () => {
    expect((await load(null)).size).toBe(0)
  })

  it("gives no sections for a list, a string, a number or a boolean in place of the map", async () => {
    for (const body of [[], ["a"], "runtime", 7, true]) expect((await load(body)).size).toBe(0)
  })

  it("drops an entry that is not a section and keeps the sound ones beside it", async () => {
    const sections = await load({
      "/a#one": { title: "One" },
      "/a#two": null,
      "/a#three": "Three",
      "/a#four": { parent: "One" },
      "/a#five": { title: 5, text: "x" },
      "/a#six": { title: "Six", parent: 3, text: ["no"] },
    })

    expect([...sections.keys()]).toEqual(["/a#one", "/a#six"])
    expect(sections.get("/a#six")).toEqual({ title: "Six", parent: undefined, text: undefined })
  })

  it("treats an address that names a prototype property as an ordinary key", async () => {
    const sections = await load(
      JSON.parse('{"constructor":{"title":"C"},"toString":{"title":"T"}}'),
    )

    expect(sections.get("constructor")?.title).toBe("C")
    expect(sections.get("hasOwnProperty")).toBeUndefined()
  })

  it("never builds a function from a string, which the site's content security policy refuses", async () => {
    await load({ "/a#one": { title: "One" } })

    expect(compiled).toEqual([])
  })

  it("gives no sections for a missing file, however the host words it", async () => {
    expect((await load({ "/a#one": { title: "One" } }, false)).size).toBe(0)
  })

  it("gives no sections for a body that is not JSON", async () => {
    const request = () =>
      Promise.resolve(file(() => Promise.reject(new SyntaxError("Unexpected token <"))))

    expect((await loadSearchSections(request)).size).toBe(0)
  })

  it("gives no sections when the request itself fails", async () => {
    expect(
      (await loadSearchSections(() => Promise.reject(new TypeError("Failed to fetch")))).size,
    ).toBe(0)
  })
})
