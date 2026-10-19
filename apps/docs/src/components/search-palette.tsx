"use client"

import { useDocsSearch } from "fumadocs-core/search/client"
import { staticClient } from "fumadocs-core/search/client/orama-static"
import { CornerDownLeft, ArrowDown, ArrowUp, FileText, Hash, Search, SearchX } from "lucide-react"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

import type { SearchSection } from "../content/search-sections.ts"
import { suggestedHrefs, type Sidebar } from "../content/sidebar.ts"

type Filter = "All" | "Documentation" | "API reference"

const filters: ReadonlyArray<Filter> = ["All", "Documentation", "API reference"]

interface PageEntry {
  readonly href: string
  readonly title: string
  readonly description?: string | undefined
  readonly group: string
  readonly product: string
}

interface Row {
  readonly key: string
  readonly href: string
  readonly kind: "page" | "heading"
  readonly title: string
  readonly snippet?: string | undefined
  readonly trail: string
  readonly product: string
}

let sectionsRequest: Promise<Record<string, SearchSection>> | undefined

const loadSections = (): Promise<Record<string, SearchSection>> => {
  sectionsRequest ??= fetch("/search-sections.json")
    .then((response): Promise<Record<string, SearchSection>> => response.json())
    .catch((): Record<string, SearchSection> => ({}))

  return sectionsRequest
}

const highlight = (text: string, terms: ReadonlyArray<string>): ReactNode => {
  if (terms.length === 0) return text

  const pattern = new RegExp(
    `(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  )

  return text
    .split(pattern)
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))
}

const windowed = (text: string, terms: ReadonlyArray<string>): string => {
  const lower = text.toLowerCase()
  const at = Math.min(
    ...terms.flatMap((term) => {
      const index = lower.indexOf(term.toLowerCase())

      return index >= 0 ? [index] : []
    }),
  )

  return Number.isFinite(at) && at > 40 ? `…${text.slice(at - 40)}` : text
}

/**
 * The search palette. It searches the index the build wrote to `/search.json`, which the
 * browser downloads when the palette first opens, and every query runs in the browser. The
 * tabs narrow the search to one section, Tab cycles them, the arrows move through the
 * results, Enter opens one and Escape closes the palette.
 */
export function SearchPalette(props: {
  readonly sidebars: ReadonlyArray<Sidebar>
  readonly onClose: () => void
}) {
  const [filter, setFilter] = useState<Filter>("All")
  const [highlighted, setHighlighted] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const client = useMemo(
    () => staticClient({ from: "/search.json", tag: filter === "All" ? undefined : filter }),
    [filter],
  )
  const { search, onSearchChange, data } = useDocsSearch({ client })
  const [sections, setSections] = useState<Record<string, SearchSection>>({})

  useEffect(() => {
    void loadSections().then(setSections)
  }, [])

  const pages = useMemo(
    () =>
      new Map<string, PageEntry>(
        props.sidebars.flatMap((sidebar) =>
          sidebar.groups.flatMap((group) =>
            group.items.map((item): [string, PageEntry] => [
              item.href,
              {
                href: item.href,
                title: item.title,
                description: item.description,
                group: group.heading ?? sidebar.product.title,
                product: sidebar.product.title,
              },
            ]),
          ),
        ),
      ),
    [props.sidebars],
  )

  const terms = useMemo(() => search.split(/\s+/).filter((term) => term !== ""), [search])

  const rows = useMemo((): ReadonlyArray<Row> => {
    if (terms.length === 0)
      return suggestedHrefs.flatMap((href) => {
        const page = pages.get(href)

        return page === undefined
          ? []
          : [
              {
                key: href,
                href,
                kind: "page" as const,
                title: page.title,
                trail: page.group,
                product: "Suggested",
              },
            ]
      })

    const items = data?.items ?? []
    const listed = new Set(items.flatMap((item) => (item.type === "page" ? [item.url] : [])))
    const paragraphs = new Set(items.flatMap((item) => (item.type === "text" ? [item.url] : [])))

    return items.flatMap((item): ReadonlyArray<Row> => {
      if (item.type === "table") return []

      const address = item.url.split("#")[0] ?? ""
      const page = pages.get(address)

      if (page === undefined) return []

      const describes = item.type === "text" && item.content === page.description

      if (item.type === "page" || (describes && !listed.has(address)))
        return [
          {
            key: item.id,
            href: item.url,
            kind: "page",
            title: item.type === "page" ? item.content : page.title,
            snippet: page.description === undefined ? undefined : windowed(page.description, terms),
            trail: page.group,
            product: page.product,
          },
        ]

      if (describes || (item.type === "heading" && paragraphs.has(item.url))) return []

      const section = sections[item.url]
      const opening = item.type === "text" ? item.content : section?.text

      return [
        {
          key: item.id,
          href: item.url,
          kind: "heading",
          title: item.type === "heading" ? item.content : (section?.title ?? page.title),
          snippet: opening === undefined ? undefined : windowed(opening, terms),
          trail: section?.parent === undefined ? page.title : `${page.title} › ${section.parent}`,
          product: page.product,
        },
      ]
    })
  }, [data, pages, sections, terms])

  const groups = useMemo(() => {
    const byProduct = new Map<string, Array<Row>>()

    for (const row of rows) byProduct.set(row.product, [...(byProduct.get(row.product) ?? []), row])

    return [...byProduct.entries()]
  }, [rows])

  const ordered = useMemo(() => groups.flatMap(([, group]) => group), [groups])

  useEffect(() => {
    setHighlighted(0)
  }, [ordered])

  useEffect(() => {
    list.current?.querySelector(`[data-highlighted]`)?.scrollIntoView({ block: "nearest" })
  }, [highlighted, ordered])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      props.onClose()
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setHighlighted((index) =>
        Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))),
      )
    } else if (event.key === "Enter") {
      const row = ordered[highlighted]

      if (row === undefined) return

      event.preventDefault()
      document.getElementById(`ak-cmd-${highlighted}`)?.click()
    } else if (event.key === "Tab") {
      event.preventDefault()
      const index = filters.indexOf(filter) + (event.shiftKey ? -1 : 1)

      setFilter(filters[(index + filters.length) % filters.length] ?? "All")
    }
  }

  let index = -1

  return (
    <>
      <div className="ak-cmd-backdrop" aria-hidden="true" onClick={props.onClose} />
      <div
        className="ak-cmd-stage"
        onClick={(event) => event.target === event.currentTarget && props.onClose()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search docs"
          className="ak-cmd"
          onKeyDown={onKeyDown}
        >
          <div className="ak-cmd-input-row">
            <Search className="ak-cmd-input-icon" aria-hidden="true" />
            <input
              className="ak-cmd-input"
              placeholder="Search documentation and API reference"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="ak-cmd-list"
              aria-activedescendant={`ak-cmd-${highlighted}`}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
            <kbd className="ak-kbd">Esc</kbd>
          </div>
          <div className="ak-cmd-filters" role="tablist">
            {filters.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                tabIndex={-1}
                aria-selected={filter === name}
                className="ak-cmd-filter"
                onClick={() => setFilter(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div id="ak-cmd-list" role="listbox" className="ak-cmd-list" ref={list}>
            {groups.length === 0 ? (
              <div className="ak-cmd-empty">
                <SearchX className="ak-cmd-empty-icon" aria-hidden="true" />
                <p className="ak-cmd-empty-title">No results</p>
                <p className="ak-cmd-empty-body">Try a different search term.</p>
              </div>
            ) : (
              groups.map(([product, group]) => (
                <div key={product} className="ak-cmd-group" role="group">
                  <div className="ak-cmd-label">{product}</div>
                  {group.map((row) => {
                    index += 1

                    return (
                      <Link
                        key={row.key}
                        id={`ak-cmd-${index}`}
                        href={row.href}
                        role="option"
                        aria-selected={index === highlighted}
                        className="ak-cmd-item"
                        data-highlighted={index === highlighted ? "true" : undefined}
                        onClick={props.onClose}
                        onMouseMove={(
                          (position: number) => () =>
                            setHighlighted(position)
                        )(index)}
                      >
                        <span className="ak-cmd-lead">
                          {row.kind === "page" ? (
                            <FileText aria-hidden="true" />
                          ) : (
                            <Hash aria-hidden="true" />
                          )}
                        </span>
                        <span className="ak-cmd-body">
                          <span className="ak-cmd-line">
                            <span className="ak-cmd-title">{highlight(row.title, terms)}</span>
                            <span className="ak-cmd-trail">{row.trail}</span>
                          </span>
                          {row.snippet === undefined ? null : (
                            <span className="ak-cmd-snippet">{highlight(row.snippet, terms)}</span>
                          )}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <div className="ak-cmd-footer">
            <span className="ak-cmd-hint">
              <kbd className="ak-kbd">
                <ArrowUp aria-hidden="true" />
              </kbd>
              <kbd className="ak-kbd">
                <ArrowDown aria-hidden="true" />
              </kbd>
              Navigate
            </span>
            <span className="ak-cmd-hint">
              <kbd className="ak-kbd">
                <CornerDownLeft aria-hidden="true" />
              </kbd>
              Open page
            </span>
            <span className="ak-cmd-hint">
              <kbd className="ak-kbd">Tab</kbd>
              Filter
            </span>
            <span className="ak-cmd-hint ak-cmd-hint-end">
              <kbd className="ak-kbd">Esc</kbd>
              Close
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
