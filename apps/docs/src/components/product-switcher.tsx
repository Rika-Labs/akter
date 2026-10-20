"use client"

import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import Link from "next/link"

import type { ProductId } from "../content/navigation.ts"
import { productIcons } from "../content/page-icons.ts"
import type { Sidebar } from "../content/sidebar.ts"
import { CheckGlyph, GrabberGlyph } from "./glyphs.tsx"
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
 * lists the two sections. A choice opens that section's home page. The list is a Radix
 * dropdown, so the arrow keys move through it, Escape or a choice closes it, and focus goes
 * back to the card.
 */
export function ProductSwitcher(props: {
  readonly sidebars: ReadonlyArray<Sidebar>
  readonly current: ProductId
}) {
  const selected = props.sidebars.find((sidebar) => sidebar.product.id === props.current)

  if (selected === undefined) return null

  return (
    <div className="ak-section-select">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="ak-section-trigger">
            <span className="ak-section-tile">
              <PageIcon name={productIcons[selected.product.id]} />
            </span>
            <Label title={selected.product.title} description={selected.product.description} />
            <GrabberGlyph className="ak-section-grabber" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          className="ak-section-menu"
          aria-label="Section"
          side="bottom"
          align="start"
          sideOffset={4}
          avoidCollisions={false}
          loop
        >
          <DropdownMenu.RadioGroup className="ak-menu-group" value={props.current}>
            {props.sidebars.map(({ product }) => (
              <DropdownMenu.RadioItem key={product.id} value={product.id} asChild>
                <Link className="ak-section-option" href={product.home}>
                  <span className="ak-section-tile">
                    <PageIcon name={productIcons[product.id]} />
                  </span>
                  <Label title={product.title} description={product.description} />
                  <DropdownMenu.ItemIndicator asChild>
                    <CheckGlyph className="ak-menu-check" aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </Link>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  )
}
