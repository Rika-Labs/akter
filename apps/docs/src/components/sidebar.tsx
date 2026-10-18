"use client"

import { ArrowUpRight, Search } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"

import { signInUrl, repositoryUrl, xUrl } from "../content/site.ts"
import type { Sidebar as SidebarModel, SidebarGroup } from "../content/sidebar.ts"
import { AppearanceMenu } from "./appearance-menu.tsx"
import { GitHubMark, PageIcon, XMark } from "./icons.tsx"
import { ProductSwitcher } from "./product-switcher.tsx"

const routeOf = (pathname: string): string => (pathname === "/" ? "/welcome" : pathname)

/** The section whose sidebar lists the page, or the first section for any other path. */
const sidebarFor = (sidebars: ReadonlyArray<SidebarModel>, pathname: string): SidebarModel => {
  const route = routeOf(pathname)

  return (
    sidebars.find((sidebar) =>
      sidebar.groups.some((group) => group.items.some((item) => item.href === route)),
    ) ?? sidebars[0]!
  )
}

function Rows(props: { readonly group: SidebarGroup; readonly route: string }) {
  return (
    <div className="ak-group">
      {props.group.items.map((item) => (
        <Link
          key={item.href}
          className="ak-row"
          href={item.href}
          data-active={item.href === props.route ? "true" : undefined}
        >
          <PageIcon name={item.icon} />
          <span className="ak-row-label">{item.title}</span>
        </Link>
      ))}
    </div>
  )
}

/**
 * The fixed column on the left: the logo, the section switcher, the search button, the
 * pages of the selected section, and the appearance menu with the links out. On a narrow
 * screen it is the drawer the top bar opens.
 */
export function Sidebar(props: {
  readonly logo: ReactNode
  readonly sidebars: ReadonlyArray<SidebarModel>
  readonly pathname: string
  readonly onSearch: () => void
}) {
  const current = sidebarFor(props.sidebars, props.pathname)
  const route = routeOf(props.pathname)

  return (
    <aside className="ak-sidebar">
      <div className="ak-brand">
        <Link className="ak-wordmark" aria-label="Akter docs" href="/welcome">
          {props.logo}
        </Link>
      </div>
      <ProductSwitcher sidebars={props.sidebars} current={current.product.id} />
      <button type="button" className="ak-search-btn" onClick={props.onSearch}>
        <Search className="ak-icon" aria-hidden="true" />
        <span>Search</span>
        <kbd className="ak-kbd">⌘K</kbd>
      </button>
      <nav className="ak-nav" aria-label={current.product.title}>
        {current.groups.map((group) =>
          group.heading === undefined ? (
            <Rows key="top" group={group} route={route} />
          ) : (
            <div key={group.heading} className="ak-section-group">
              <p className="ak-section-head">
                <span className="ak-row-label">{group.heading}</span>
              </p>
              <Rows group={group} route={route} />
            </div>
          ),
        )}
      </nav>
      <div className="ak-group ak-sidebar-foot">
        <AppearanceMenu />
        <div className="ak-foot-row">
          <a className="ak-row" href={signInUrl}>
            <ArrowUpRight className="ak-icon" aria-hidden="true" />
            <span className="ak-row-label">Open Akter</span>
          </a>
          <a className="ak-icon-btn" href={xUrl} aria-label="Rika Labs on X">
            <XMark />
          </a>
          <a className="ak-icon-btn" href={repositoryUrl} aria-label="Akter on GitHub">
            <GitHubMark />
          </a>
        </div>
      </div>
    </aside>
  )
}
