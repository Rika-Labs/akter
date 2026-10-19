"use client"

import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { themeStorageKey } from "../content/theme-script.ts"

type Choice = "light" | "dark" | "system"

const choices: ReadonlyArray<{
  readonly value: Choice
  readonly label: string
  readonly Icon: LucideIcon
}> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
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
 * removes both, so the page follows the operating system.
 */
export function AppearanceMenu() {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<Choice>("system")
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setChoice(stored())
  }, [])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true)
        setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)

    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const choose = (value: Choice) => {
    const classes = document.documentElement.classList

    classes.remove("light", "dark")

    if (value === "system") window.localStorage.removeItem(themeStorageKey)
    else {
      classes.add(value)
      window.localStorage.setItem(themeStorageKey, value)
    }

    setChoice(value)
    setOpen(false)
  }

  return (
    <div className="ak-appearance" ref={root}>
      {open ? (
        <div className="ak-menu" role="menu" aria-label="Appearance">
          {choices.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === value}
              className="ak-menu-row"
              onClick={() => choose(value)}
            >
              <Icon className="ak-menu-icon" aria-hidden="true" />
              {label}
              {choice === value ? <Check className="ak-menu-check" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="ak-row"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ContrastIcon />
        <span className="ak-row-label">Appearance</span>
      </button>
    </div>
  )
}
