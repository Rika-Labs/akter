import type { ReactNode } from "react"

import { DocsShell } from "../../components/docs-shell.tsx"

export default function DocsRouteLayout({ children }: { children: ReactNode }) {
  return <DocsShell>{children}</DocsShell>
}
