import type { Metadata } from "next"

import { Welcome } from "../../components/welcome.tsx"
import { welcomePageUrl, welcomeDescription, welcomeTitle } from "../../content/welcome.ts"

export const metadata: Metadata = {
  title: welcomeTitle,
  description: welcomeDescription,
  alternates: { canonical: welcomePageUrl },
  openGraph: { url: welcomePageUrl, title: welcomeTitle, description: welcomeDescription },
}

export default Welcome
