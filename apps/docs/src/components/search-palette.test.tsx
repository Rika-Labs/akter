import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createSearchAPI } from "fumadocs-core/search/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildSidebars } from "../content/sidebar.ts"
import "./dom-environment.ts"

const sidebars = buildSidebars((slug) => ({ title: slug, description: undefined }))

const index = await createSearchAPI("advanced", {
  indexes: [
    {
      id: "welcome",
      title: "Welcome",
      url: "/welcome",
      structuredData: {
        headings: [],
        contents: [{ heading: undefined, content: "An actor owns its state." }],
      },
    },
  ],
})
  .staticGET()
  .then((response) => response.text())

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const open = async (answers: ReadonlyArray<number>) => {
  const requested: Array<string> = []

  vi.stubGlobal("fetch", async (address: string) => {
    requested.push(address)

    if (address === "/search-sections.json") return new Response("{}")

    const status =
      answers[
        Math.min(
          requested.filter((a) => a.startsWith("/search.json")).length - 1,
          answers.length - 1,
        )
      ]

    return new Response(status === 200 ? index : "{}", { status })
  })

  const { SearchPalette } = await import("./search-palette.tsx")
  const user = userEvent.setup()

  render(<SearchPalette sidebars={sidebars} onClose={() => {}} />)

  return { user, requested, input: screen.getByRole("combobox") }
}

describe("SearchPalette", () => {
  it("limits empty-query suggestions to the selected product and restores all suggestions", async () => {
    const { user, requested, input } = await open([200])
    const hrefs = () => screen.getAllByRole("option").map((option) => option.getAttribute("href"))
    const documentation = ["/getting-started", "/core/actors", "/core/commands"]
    const api = ["/reference/server", "/reference/cli"]

    expect(hrefs()).toEqual([...documentation, ...api])

    await user.click(screen.getByRole("tab", { name: /^Documentation$/ }))
    expect(hrefs()).toEqual(documentation)

    await user.click(screen.getByRole("tab", { name: /^API reference$/ }))
    expect(hrefs()).toEqual(api)

    await user.click(screen.getByRole("tab", { name: /^All$/ }))
    expect(hrefs()).toEqual([...documentation, ...api])
    expect((input as HTMLInputElement).value).toBe("")
    expect(requested.filter((address) => address.startsWith("/search.json"))).toEqual([])
  })

  it("says search is unavailable when the index fails to load, then finds results on the next keystroke", async () => {
    const { user, requested, input } = await open([500, 200])

    await user.type(input, "ac")
    await screen.findByText("Search unavailable.")
    expect(screen.getByText("Try again.")).toBeTruthy()
    expect(screen.queryByText("No results")).toBeNull()

    await user.type(input, "tor")

    await waitFor(() => expect(screen.queryByText("Search unavailable.")).toBeNull())
    expect(await screen.findAllByRole("option")).not.toHaveLength(0)
    expect(requested.filter((address) => address.startsWith("/search.json"))).toEqual([
      "/search.json",
      "/search.json?retry=1",
    ])
  })

  it("shows no message while the index loads", async () => {
    const { user, input } = await open([200])

    await user.type(input, "actor")

    expect(await screen.findAllByRole("option")).not.toHaveLength(0)
    expect(screen.queryByText("Search unavailable.")).toBeNull()
  })
})
