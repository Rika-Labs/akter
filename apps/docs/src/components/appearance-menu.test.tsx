import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { AppearanceMenu } from "./appearance-menu.tsx"
import "./dom-environment.ts"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.className = ""
})

const choice = (name: string) => screen.getByRole("menuitemradio", { name })

const setup = () => {
  const user = userEvent.setup()

  render(<AppearanceMenu />)

  const trigger = screen.getByRole("button", { name: "Appearance" })

  trigger.focus()

  return { user, trigger }
}

describe("AppearanceMenu keyboard", () => {
  it("opens onto its first choice with ArrowDown and moves through the choices with the arrow keys", async () => {
    const { user } = setup()

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(choice("Light"))

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(choice("Dark"))

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(choice("System"))

    await user.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(choice("Dark"))
  })

  it("wraps from the last choice to the first and back", async () => {
    const { user } = setup()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(choice("System"))

    await user.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(choice("Light"))

    await user.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(choice("System"))
  })

  it("closes on Escape and gives focus back to the Appearance button", async () => {
    const { user, trigger } = setup()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    expect(screen.queryByRole("menu")).not.toBeNull()

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it("applies a choice made with Enter and gives focus back to the Appearance button", async () => {
    const { user, trigger } = setup()

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Enter}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(window.localStorage.getItem("akter-theme")).toBe("dark")
    expect(document.activeElement).toBe(trigger)
  })

  it("removes the stored choice when System is chosen with the keyboard", async () => {
    const { user, trigger } = setup()

    window.localStorage.setItem("akter-theme", "light")
    document.documentElement.classList.add("light")

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{Enter}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(window.localStorage.getItem("akter-theme")).toBeNull()
    expect(document.documentElement.className).toBe("")
    expect(document.activeElement).toBe(trigger)
  })
})
