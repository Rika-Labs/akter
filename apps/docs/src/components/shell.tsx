"use client"

import { PanelLeft, Search } from "lucide-react"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"

import type { Sidebar as SidebarModel } from "../content/sidebar.ts"
import { SearchPalette } from "./search-palette.tsx"
import { Sidebar } from "./sidebar.tsx"

/**
 * The page frame. It holds the two pieces of state that cross its parts, the mobile drawer
 * and the search palette, and the keys that drive them: Command or Control K toggles
 * search, and Escape closes the drawer. Opening a page closes the drawer.
 */
export function Shell(props: {
  readonly logo: ReactNode
  readonly sidebars: ReadonlyArray<SidebarModel>
  readonly children: ReactNode
}) {
  const pathname = usePathname()
  const [drawer, setDrawer] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    setDrawer(false)
  }, [pathname])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearching((open) => !open)
        return
      }

      if (event.key === "Escape") setDrawer(false)
    }

    window.addEventListener("keydown", onKeyDown)

    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div className="ak-shell" data-drawer={drawer ? "" : undefined}>
      <header className="ak-mobilebar">
        <button
          type="button"
          className="ak-icon-btn"
          aria-label="Open navigation"
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
        >
          <PanelLeft aria-hidden="true" />
        </button>
        <a className="ak-wordmark" aria-label="Akter docs" href="/welcome">
          {props.logo}
        </a>
        <button
          type="button"
          className="ak-icon-btn"
          aria-label="Search"
          onClick={() => setSearching(true)}
        >
          <Search aria-hidden="true" />
        </button>
      </header>
      <div className="ak-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />
      <Sidebar
        logo={props.logo}
        sidebars={props.sidebars}
        pathname={pathname}
        onSearch={() => setSearching(true)}
      />
      <main id="ak-main" className="ak-main" tabIndex={-1}>
        {props.children}
      </main>
      {searching ? (
        <SearchPalette sidebars={props.sidebars} onClose={() => setSearching(false)} />
      ) : null}
    </div>
  )
}
