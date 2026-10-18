"use client"

import { Check, ChevronsUpDown } from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import type { ProductId } from "../content/navigation.ts"
import { productIcons } from "../content/page-icons.ts"
import type { Sidebar } from "../content/sidebar.ts"
import { PageIcon } from "./icons.tsx"

function Label(props: { readonly title: string; readonly description: string }) {
  return (
    <span className="ak-section-text">
      <span className="ak-section-title">{props.title}</span>
      <span className="ak-section-desc">{props.description}</span>
    </span>
  )
}

/**
 * The card at the top of the sidebar that names the selected section and, when opened,
 * lists the two sections. A choice opens that section's home page.
 */
export function ProductSwitcher(props: {
  readonly sidebars: ReadonlyArray<Sidebar>
  readonly current: ProductId
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const selected = props.sidebars.find((sidebar) => sidebar.product.id === props.current)

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

  if (selected === undefined) return null

  return (
    <div className="ak-section-select" ref={root}>
      <button
        type="button"
        className="ak-section-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ak-section-tile">
          <PageIcon name={productIcons[selected.product.id]} />
        </span>
        <Label title={selected.product.title} description={selected.product.description} />
        <ChevronsUpDown className="ak-section-grabber" aria-hidden="true" />
      </button>
      {open ? (
        <div className="ak-section-menu" role="menu" aria-label="Section">
          {props.sidebars.map(({ product }) => (
            <Link
              key={product.id}
              role="menuitemradio"
              aria-checked={product.id === props.current}
              className="ak-section-option"
              href={product.home}
              onClick={() => setOpen(false)}
            >
              <span className="ak-section-tile">
                <PageIcon name={productIcons[product.id]} />
              </span>
              <Label title={product.title} description={product.description} />
              {product.id === props.current ? (
                <Check className="ak-menu-check" aria-hidden="true" />
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}
