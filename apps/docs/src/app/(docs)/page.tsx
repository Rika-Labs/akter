import type { Metadata } from "next"

import { Landing } from "../../components/landing.tsx"
import { landingMetadata, welcomePage } from "../../content/landing-pages.ts"

export const metadata: Metadata = landingMetadata(welcomePage)

export default function Page() {
  return <Landing page={welcomePage} />
}
