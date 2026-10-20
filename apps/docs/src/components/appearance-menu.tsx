"use client"

import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Moon } from "lucide-react"
import { useEffect, useState, type ComponentType, type SVGProps } from "react"

import { themeStorageKey } from "../content/theme-script.ts"
import { CheckGlyph, SunGlyph, SystemGlyph } from "./glyphs.tsx"

type Choice = "light" | "dark" | "system"

const choices: ReadonlyArray<{
  readonly value: Choice
  readonly label: string
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>
}> = [
  { value: "light", label: "Light", Icon: SunGlyph },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SystemGlyph },
]

/** The Appearance icon: a circle whose right half is drawn as three vertical strokes. */
const ContrastIcon = () => (
  <svg
    className="ak-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3.5v17M15 4v16M18 5.5v13" />
  </svg>
)

const stored = (): Choice => {
  const value = window.localStorage.getItem(themeStorageKey)

  return value === "light" || value === "dark" ? value : "system"
}

/**
 * The Appearance row at the foot of the sidebar and its menu of Light, Dark and System.
 * A choice sets the class the stylesheet reads on the root element and is kept in local
 * storage, where the script in the document head reads it before the first paint. System
 * removes both, so the page follows the operating system. The menu is a Radix dropdown, so
 * the arrow keys move through the choices, Escape or a choice closes it, and focus goes back
 * to the row that opened it.
 */
export function AppearanceMenu() {
  const [choice, setChoice] = useState<Choice>("system")

  useEffect(() => {
    setChoice(stored())
  }, [])

  const choose = (value: string) => {
    if (value !== "light" && value !== "dark" && value !== "system") return

    const classes = document.documentElement.classList

    classes.remove("light", "dark")

    if (value === "system") window.localStorage.removeItem(themeStorageKey)
    else {
      classes.add(value)
      window.localStorage.setItem(themeStorageKey, value)
    }

    setChoice(value)
  }

  return (
    <div className="ak-appearance">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="ak-row">
            <ContrastIcon />
            <span className="ak-row-label">Appearance</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="ak-menu"
          aria-label="Appearance"
          side="top"
          align="start"
          sideOffset={4}
          avoidCollisions={false}
          loop
        >
          <DropdownMenu.RadioGroup className="ak-menu-group" value={choice} onValueChange={choose}>
            {choices.map(({ value, label, Icon }) => (
              <DropdownMenu.RadioItem key={value} value={value} className="ak-menu-row">
                <Icon className="ak-menu-icon" aria-hidden="true" />
                {label}
                <DropdownMenu.ItemIndicator asChild>
                  <CheckGlyph className="ak-menu-check" aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  )
}
