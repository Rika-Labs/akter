"use client"

import { usePathname } from "next/navigation"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { drawerFocus } from "../content/drawer.ts"
import type { Sidebar as SidebarModel } from "../content/sidebar.ts"
import { NavGlyph, SearchGlyph } from "./glyphs.tsx"
import { SearchPalette } from "./search-palette.tsx"
import { Sidebar } from "./sidebar.tsx"

/**
 * The page frame. It holds the two pieces of state that cross its parts, the mobile drawer
 * and the search palette, and the keys that drive them: Command or Control K toggles
 * search, and Escape closes the drawer. Opening a page, or choosing any link in the drawer,
 * closes it. While the drawer is open focus is inside it and the rest of the page is inert,
 * and closing it puts focus back on the button that opened it. The search palette takes focus
 * from the drawer while it is open and gives it back to what had it when the palette closes.
 * Focus is always moved without scrolling: the button sits in a sticky bar, and focusing it
 * scrolls the page, which moved the offset that Back restores after a page chosen in the drawer.
 * The frame layer is drawn over the scrolling page: it paints the margin and the rounded
 * corners around the panel, which keeps the panel's look while the document itself is what
 * scrolls.
 */
export function Shell(props: {
  readonly logo: ReactNode
  readonly sidebars: ReadonlyArray<SidebarModel>
  readonly children: ReactNode
}) {
  const pathname = usePathname()
  const [drawer, setDrawer] = useState(false)
  const [searching, setSearching] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)
  const was = useRef(false)
  const searchOpen = useRef(false)
  const searchOrigin = useRef<HTMLElement | null>(null)

  const openSearch = () => {
    searchOrigin.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    searchOpen.current = true
    setSearching(true)
  }

  const closeSearch = () => {
    const origin = searchOrigin.current

    searchOrigin.current = null
    searchOpen.current = false
    setSearching(false)

    if (origin !== null && origin !== document.body && origin.isConnected)
      origin.focus({ preventScroll: true })
  }

  useEffect(() => {
    setDrawer(false)
  }, [pathname])

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)")
    const onChange = () => {
      if (wide.matches) setDrawer(false)
    }

    wide.addEventListener("change", onChange)

    return () => wide.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    const focus = drawerFocus(was.current, drawer)

    was.current = drawer

    if (focus === "enter")
      sidebar.current?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true })
    if (focus === "return") opener.current?.focus({ preventScroll: true })
  }, [drawer])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        if (searchOpen.current) closeSearch()
        else openSearch()
        return
      }

      if (event.key === "Escape" && !event.defaultPrevented) setDrawer(false)
    }

    window.addEventListener("keydown", onKeyDown)

    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div className="ak-shell" data-drawer={drawer ? "" : undefined}>
      <header className="ak-mobilebar" inert={drawer}>
        <button
          ref={opener}
          type="button"
          className="ak-icon-btn"
          aria-label="Open navigation"
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
        >
          <NavGlyph aria-hidden="true" />
        </button>
        <a className="ak-wordmark" aria-label="Akter docs" href="/welcome">
          {props.logo}
        </a>
        <button type="button" className="ak-icon-btn" aria-label="Search" onClick={openSearch}>
          <SearchGlyph aria-hidden="true" />
        </button>
      </header>
      <div className="ak-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />
      <Sidebar
        ref={sidebar}
        logo={props.logo}
        sidebars={props.sidebars}
        pathname={pathname}
        trapped={drawer && !searching}
        onNavigate={() => setDrawer(false)}
        onSearch={openSearch}
      />
      <main id="ak-main" className="ak-main" tabIndex={-1} inert={drawer}>
        {props.children}
      </main>
      <div className="ak-frame" aria-hidden="true" />
      {searching ? <SearchPalette sidebars={props.sidebars} onClose={closeSearch} /> : null}
    </div>
  )
}
