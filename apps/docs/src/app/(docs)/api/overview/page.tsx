import type { Metadata } from "next"

import { Overview } from "../../../../components/landing.tsx"
import { landingMetadata } from "../../../../content/landing-pages.ts"
import { generatedPages } from "../../../../content/source.ts"

const page = generatedPages.find((candidate) => candidate.slug === "api/overview")!

export const metadata: Metadata = landingMetadata(page)

export default function Page() {
  return <Overview page={page} />
}
