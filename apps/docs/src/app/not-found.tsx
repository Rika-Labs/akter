import { DefaultNotFound } from "fumadocs-ui/layouts/home/not-found"
import { HomeLayout } from "fumadocs-ui/layouts/home"

import { layoutOptions } from "../components/layout-options.tsx"

export default function NotFound() {
  return (
    <HomeLayout {...layoutOptions}>
      <DefaultNotFound />
    </HomeLayout>
  )
}
