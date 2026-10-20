import { createSearchAPI } from "fumadocs-core/search/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const index = await createSearchAPI("advanced", {
  indexes: [
    {
      id: "guides/actors",
      title: "Actors",
      url: "/guides/actors",
      structuredData: {
        headings: [],
        contents: [{ heading: undefined, content: "An actor owns its state." }],
      },
    },
  ],
})
  .staticGET()
  .then((response) => response.text())

const answer = (status: number): Response =>
  new Response(status === 200 ? index : "{}", {
    status,
    headers: { "content-type": "application/json" },
  })

const load = async () => (await import("./search-index.ts")).searchClient(undefined)

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("searchClient", () => {
  it("searches again, at a new address, after the index failed to load once", async () => {
    const fetched = vi.fn(async (address: string) => answer(address === "/search.json" ? 500 : 200))

    vi.stubGlobal("fetch", fetched)

    const client = await load()

    await expect(client.search("actor")).rejects.toThrow("failed to fetch exported search indexes")
    await expect(client.search("actor")).resolves.toEqual([
      expect.objectContaining({ type: "page", url: "/guides/actors" }),
      expect.objectContaining({ type: "text", url: "/guides/actors" }),
    ])
    expect(fetched.mock.calls.map(([address]) => address)).toEqual([
      "/search.json",
      "/search.json?retry=1",
    ])
  })

  it("loads the index once while it keeps loading", async () => {
    const fetched = vi.fn(async () => answer(200))

    vi.stubGlobal("fetch", fetched)

    const client = await load()

    await client.search("actor")
    await client.search("state")
    await (await load()).search("owns")

    expect(fetched).toHaveBeenCalledTimes(1)
  })

  it("moves on to a new address for each failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(503)),
    )

    const client = await load()
    const { searchIndexAddress } = await import("./search-index.ts")

    await expect(client.search("a")).rejects.toThrow()
    await expect(client.search("a")).rejects.toThrow()

    expect(searchIndexAddress()).toBe("/search.json?retry=2")
  })
})
