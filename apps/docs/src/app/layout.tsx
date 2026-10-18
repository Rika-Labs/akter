import "./global.css"

import { RootProvider } from "fumadocs-ui/provider/next"
import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import type { ReactNode } from "react"

import StaticSearchDialog from "../components/search-dialog.tsx"
import { polySansUrl, siteDescription, siteName, siteUrl } from "../content/site.ts"

const mono = localFont({
  src: "../../../../docs/fonts/GeistMono-latin.woff2",
  display: "optional",
  weight: "100 900",
  variable: "--font-akter-mono",
  adjustFontFallback: "Arial",
  fallback: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
})

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
 * The document shell. Colours come from the `prefers-color-scheme` media query in CSS and
 * the fonts are preloaded here, so the first byte of HTML already carries everything the
 * first paint needs: no theme script, no late font swap. The expect link holds the first
 * paint until the parser reaches the end marker, so Chromium never paints a half-parsed page.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <head>
        <link rel="expect" href="#end-of-page" blocking="render" />
        <link
          rel="preload"
          href={polySansUrl}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider theme={{ enabled: false }} search={{ SearchDialog: StaticSearchDialog }}>
          {children}
        </RootProvider>
        <div id="end-of-page" hidden />
      </body>
    </html>
  )
}
