import { DocsLayout } from "fumadocs-ui/layouts/notebook"
import type { ReactNode } from "react"

import { layoutOptions } from "../../components/layout-options.tsx"
import { pageTree } from "../../content/source.ts"

export default function DocsRouteLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      {...layoutOptions}
      tree={pageTree}
      tabMode="navbar"
      nav={{ ...layoutOptions.nav, mode: "top" }}
    >
      {children}
    </DocsLayout>
  )
}
