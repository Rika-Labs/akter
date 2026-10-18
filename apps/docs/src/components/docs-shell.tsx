import type { ReactNode } from "react"

import { sidebars } from "../content/source.ts"
import { Logo } from "./logo.tsx"
import { Shell } from "./shell.tsx"

/** The frame every page sits in: the sidebar, the mobile bar and the inset panel. */
export function DocsShell(props: { readonly children: ReactNode }) {
  return (
    <Shell logo={<Logo />} sidebars={sidebars}>
      {props.children}
    </Shell>
  )
}
