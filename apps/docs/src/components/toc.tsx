"use client"

import { useEffect, useState } from "react"

import type { TocItem } from "../content/toc-items.ts"

const ACTIVE_OFFSET = 96

/**
 * The heading nearest above the top of the scrolling panel, or the first heading before any
 * has scrolled past. At the very end of the page the last heading wins, since a short
 * final section may never reach the top.
 */
const activeHeading = (items: ReadonlyArray<TocItem>, panel: HTMLElement): string | undefined => {
  if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2) return items.at(-1)?.id

  const top = panel.getBoundingClientRect().top + ACTIVE_OFFSET
  let active = items[0]?.id

  for (const item of items) {
    const heading = document.getElementById(item.id)

    if (heading !== null && heading.getBoundingClientRect().top <= top) active = item.id
  }

  return active
}

/**
 * The "On this page" list at the right of a page. The rail beside the entries is drawn by
 * the stylesheet from each entry's level and its neighbours', so the server's first paint
 * already has it; the entry of the heading in view is marked as the panel scrolls.
 */
export function Toc(props: { readonly items: ReadonlyArray<TocItem> }) {
  const [active, setActive] = useState(props.items[0]?.id)

  useEffect(() => {
    const panel = document.getElementById("ak-main")

    if (panel === null) return

    let queued = false
    const update = () => {
      queued = false
      setActive(activeHeading(props.items, panel))
    }
    const onScroll = () => {
      if (queued) return

      queued = true
      window.requestAnimationFrame(update)
    }

    update()
    panel.addEventListener("scroll", onScroll, { passive: true })

    return () => panel.removeEventListener("scroll", onScroll)
  }, [props.items])

  if (props.items.length === 0) return null

  return (
    <nav className="ak-toc" aria-label="On this page">
      <p className="ak-toc-title">On this page</p>
      <div className="ak-toc-list">
        {props.items.map((item, index) => {
          const before = props.items[index - 1]
          const after = props.items[index + 1]
          const level = (depth: number) => (depth >= 3 ? 3 : 2)

          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="ak-toc-item"
              data-depth={item.depth}
              data-active={item.id === active}
              data-jog={
                before === undefined || level(before.depth) === level(item.depth)
                  ? undefined
                  : level(item.depth) > level(before.depth)
                    ? "in"
                    : "out"
              }
              data-join-up={
                before !== undefined && level(before.depth) === level(item.depth) ? "" : undefined
              }
              data-join-down={
                after !== undefined && level(after.depth) === level(item.depth) ? "" : undefined
              }
            >
              {item.title}
            </a>
          )
        })}
      </div>
    </nav>
  )
}
