import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildSidebars } from "../content/sidebar.ts"
import "./dom-environment.ts"
import { ProductSwitcher } from "./product-switcher.tsx"

const sidebars = buildSidebars((slug) => ({ title: slug, description: undefined }))

const keepPage = (event: Event) => event.preventDefault()

beforeEach(() => document.addEventListener("click", keepPage))

afterEach(() => {
  cleanup()
  document.removeEventListener("click", keepPage)
})

const setup = () => {
  const user = userEvent.setup()

  render(<ProductSwitcher sidebars={sidebars} current="documentation" />)

  const trigger = screen.getByRole("button", { name: /Documentation/ })

  trigger.focus()

  return { user, trigger }
}

describe("ProductSwitcher keyboard", () => {
  it("opens onto an item with ArrowDown and moves to the other section with the next ArrowDown", async () => {
    const { user } = setup()

    await user.keyboard("{ArrowDown}")

    const first = document.activeElement

    expect(first?.getAttribute("role")).toBe("menuitemradio")
    expect(first?.textContent).toContain("Documentation")

    await user.keyboard("{ArrowDown}")

    expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio")
    expect(document.activeElement?.textContent).toContain("API reference")
  })

  it("wraps from the last section to the first", async () => {
    const { user } = setup()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    expect(document.activeElement?.textContent).toContain("API reference")

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement?.textContent).toContain("Documentation")
  })

  it("closes on Escape and gives focus back to the switcher", async () => {
    const { user, trigger } = setup()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it("opens the other section with Enter and gives focus back to the switcher", async () => {
    const { user, trigger } = setup()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")

    const target = document.activeElement?.getAttribute("href")

    await user.keyboard("{Enter}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(target).toBe("/api/overview")
    expect(document.activeElement).toBe(trigger)
  })
})
