import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildSidebars } from "../content/sidebar.ts"
import { resizeTo } from "./dom-environment.ts"
import { Shell } from "./shell.tsx"

const sidebars = buildSidebars((slug) => ({ title: slug, description: undefined }))

const keepPage = (event: Event) => event.preventDefault()

beforeEach(() => {
  document.addEventListener("click", keepPage)
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}))
})

afterEach(() => {
  cleanup()
  resizeTo(false)
  document.removeEventListener("click", keepPage)
  vi.unstubAllGlobals()
})

const setup = () => {
  const user = userEvent.setup()
  const view = render(
    <PathnameContext.Provider value="/quickstart">
      <Shell logo={<span>Akter</span>} sidebars={sidebars}>
        <a href="/elsewhere">Outside link</a>
      </Shell>
    </PathnameContext.Provider>,
  )
  const opener = screen.getByRole("button", { name: "Open navigation" })
  const part = (selector: string) => view.container.querySelector(selector)

  return { user, opener, part }
}

const insideDrawer = () => document.activeElement?.closest(".ak-sidebar") !== null

describe("Shell drawer", () => {
  it("takes no focus when the page loads", () => {
    setup()

    expect(document.activeElement).toBe(document.body)
  })

  it("moves focus into the drawer when it opens and makes the bar and the page inert", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)

    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(true)
    expect(insideDrawer()).toBe(true)
    expect(part(".ak-mobilebar")?.hasAttribute("inert")).toBe(true)
    expect(part("#ak-main")?.hasAttribute("inert")).toBe(true)
    expect(part(".ak-sidebar")?.hasAttribute("inert")).toBe(false)
  })

  it("keeps focus in the drawer through a lap of Tab and of Shift and Tab", async () => {
    const { user, opener } = setup()

    await user.click(opener)

    const stops = screen.getAllByRole("link").length + screen.getAllByRole("button").length

    for (let press = 0; press < stops + 2; press++) {
      await user.tab()
      expect(insideDrawer(), "Tab " + press).toBe(true)
    }

    for (let press = 0; press < stops + 2; press++) {
      await user.tab({ shift: true })
      expect(insideDrawer(), "Shift and Tab " + press).toBe(true)
    }
  })

  it("closes on Escape, gives focus back to the button that opened it and ends the inert state", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)
    await user.keyboard("{Escape}")

    await waitFor(() => expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false))
    expect(document.activeElement).toBe(opener)
    expect(part(".ak-mobilebar")?.hasAttribute("inert")).toBe(false)
    expect(part("#ak-main")?.hasAttribute("inert")).toBe(false)
  })

  it("moves focus into the drawer and back without letting it scroll the page", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const { user, opener, part } = setup()

    await user.click(opener)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false))

    const calls = focus.mock.contexts.map((target, call) => ({
      target,
      preventScroll: focus.mock.calls[call]?.[0]?.preventScroll === true,
    }))
    const entered = calls.filter((call) => part(".ak-sidebar")?.contains(call.target as Node))
    const returned = calls.filter((call) => call.target === opener).at(-1)

    expect(entered.length).toBeGreaterThan(0)
    expect(entered.every((call) => call.preventScroll)).toBe(true)
    expect(returned?.preventScroll).toBe(true)
    focus.mockRestore()
  })

  it("closes on the scrim and gives focus back to the button", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)

    const scrim = part(".ak-scrim")

    if (scrim === null) throw new Error("the shell has no scrim")

    await user.click(scrim)

    await waitFor(() => expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false))
    expect(document.activeElement).toBe(opener)
  })

  it("closes when the link chosen is the page that is already open", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)
    await user.click(screen.getByRole("link", { name: "quickstart" }))

    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it("closes when a link in the drawer is activated with the keyboard", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)
    screen.getByRole("link", { name: "quickstart" }).focus()
    await user.keyboard("{Enter}")

    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it("closes for a link to another page and for a link that leaves the site", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)
    await user.click(screen.getByRole("link", { name: "guides/concepts" }))
    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false)

    await user.click(opener)
    await user.click(screen.getByRole("link", { name: "Open Akter" }))
    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false)
  })

  it("stays open when a control that is not a link is used", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)
    screen.getByRole("button", { name: "Appearance" }).focus()
    await user.keyboard("{Enter}")

    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(true)
    expect(part("#ak-main")?.hasAttribute("inert")).toBe(true)
  })

  it("closes when the window becomes wide enough to show the sidebar", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)
    resizeTo(true)

    await waitFor(() => expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(false))
    expect(part("#ak-main")?.hasAttribute("inert")).toBe(false)
  })

  it("lets the search palette take focus from the open drawer and gives it back when it closes", async () => {
    const { user, opener, part } = setup()

    await user.click(opener)

    const search = screen
      .getAllByRole("button", { name: /^Search/ })
      .find((button) => button.closest(".ak-sidebar") !== null)

    if (search === undefined) throw new Error("the drawer has no Search button")

    await user.click(search)

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")))
    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(true)

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(part(".ak-shell")?.hasAttribute("data-drawer")).toBe(true)
    expect(document.activeElement).toBe(search)
  })
})
