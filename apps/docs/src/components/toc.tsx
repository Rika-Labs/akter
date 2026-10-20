"use client"

import { AnchorProvider, TOCItem, useItems } from "fumadocs-core/toc"
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

import { estimatedSpans, railPath, thumbRange, type Span } from "../content/toc-rail.ts"
import type { TocItem } from "../content/toc-items.ts"

const sameSpans = (a: ReadonlyArray<Span>, b: ReadonlyArray<Span>): boolean =>
  a.length === b.length &&
  a.every((span, index) => span.top === b[index]?.top && span.bottom === b[index]?.bottom)

function TocList(props: { readonly items: ReadonlyArray<TocItem> }) {
  const list = useRef<HTMLDivElement>(null)
  const [spans, setSpans] = useState(() => estimatedSpans(props.items.length))
  const observed = useItems()

  useEffect(() => {
    const element = list.current

    if (element === null) return

    const update = () => {
      const measured = [...element.querySelectorAll<HTMLElement>(".ak-toc-item")].map((entry) => {
        const style = getComputedStyle(entry)

        return {
          top: entry.offsetTop + parseFloat(style.paddingTop),
          bottom: entry.offsetTop + entry.offsetHeight - parseFloat(style.paddingBottom),
        }
      })

      setSpans((current) => (sameSpans(current, measured) ? current : measured))
    }
    const resize = new ResizeObserver(update)

    resize.observe(element)
    update()

    return () => resize.disconnect()
  }, [props.items])

  const [top, bottom] = thumbRange(
    spans,
    props.items.map((_, index) => observed[index]?.active === true),
  )
  const path = railPath(
    spans,
    props.items.map((item) => item.depth),
  )

  return (
    <div ref={list} className="ak-toc-list">
      <svg aria-hidden="true" className="ak-toc-rail">
        <path d={path} />
      </svg>
      <svg
        aria-hidden="true"
        className="ak-toc-rail ak-toc-thumb"
        style={
          { "--ak-track-top": `${top}px`, "--ak-track-bottom": `${bottom}px` } as CSSProperties
        }
      >
        <path d={path} />
      </svg>
      {props.items.map((item) => (
        <TOCItem key={item.id} href={`#${item.id}`} className="ak-toc-item" data-depth={item.depth}>
          {item.title}
        </TOCItem>
      ))}
    </div>
  )
}

/**
 * The "On this page" list at the right of a page. Every heading that is in view is marked,
 * the way the library's anchor observer reports them, and a thumb on the rail beside the
 * entries covers exactly the text of the first to the last of them. The rail is in the server's
 * markup, drawn for entries of one line each, so the first paint has it and nothing is added
 * later; once the browser has measured the entries, a longer entry moves the stroke inside the
 * rail and nothing else.
 */
export function Toc(props: { readonly items: ReadonlyArray<TocItem> }) {
  const entries = useMemo(
    () => props.items.map((item) => ({ title: item.title, url: `#${item.id}`, depth: item.depth })),
    [props.items],
  )

  if (props.items.length === 0) return null

  return (
    <AnchorProvider toc={entries}>
      <nav className="ak-toc" aria-label="On this page">
        <p className="ak-toc-title">On this page</p>
        <TocList items={props.items} />
      </nav>
    </AnchorProvider>
  )
}
