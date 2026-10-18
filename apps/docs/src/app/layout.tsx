import "./global.css"
import "../../.cache/fonts.css"

import { RootProvider } from "fumadocs-ui/provider/next"
import type { Metadata, Viewport } from "next"
import type { ReactNode } from "react"

import StaticSearchDialog from "../components/search-dialog.tsx"
import { siteUrl } from "../content/build-origins.ts"
import { scrollRestoreScript } from "../content/scroll-restore-script.ts"
import { siteDescription, siteName } from "../content/site.ts"

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#121311" },
  ],
}

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${siteName} documentation`, template: `%s | ${siteName}` },
  description: siteDescription,
  applicationName: siteName,
  icons: { icon: "/favicon.svg" },
  openGraph: { type: "website", siteName, locale: "en_US" },
  twitter: { card: "summary" },
}

/**
 * The document shell. Colours come from the `prefers-color-scheme` media query in CSS, and
 * both fonts are embedded in the render-blocking stylesheet, so the first response carries
 * everything the first paint needs and no font request follows it: no theme script, no late
 * font swap. The expect link holds the first paint until the parser reaches the end marker, so
 * Chromium never paints a half-parsed page. The one script, before the marker, owns scroll
 * restoration.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="expect" href="#end-of-page" blocking="render" />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider theme={{ enabled: false }} search={{ SearchDialog: StaticSearchDialog }}>
          {children}
        </RootProvider>
        <script dangerouslySetInnerHTML={{ __html: scrollRestoreScript }} />
        <div id="end-of-page" hidden />
      </body>
    </html>
  )
}
