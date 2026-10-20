import "./global.css"

import type { Metadata, Viewport } from "next"
import type { ReactNode } from "react"

import { siteUrl } from "../content/build-origins.ts"
import { scrollRestoreScript } from "../content/scroll-restore-script.ts"
import { siteDescription, siteName } from "../content/site.ts"
import { themeScript } from "../content/theme-script.ts"
import { geistMono, inter } from "./fonts.ts"

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eeeeed" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a09" },
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
 * The document shell. Colours come from `color-scheme` and the `prefers-color-scheme` media
 * query in CSS. Both fonts are files of the export with a preload link in the head, so their
 * requests start before the body is parsed, and their classes on the root element name them
 * for the stylesheet. The expect link holds the first paint until the parser reaches the end
 * marker, so Chromium never paints a half-parsed page. Nothing here needs a script to hold the
 * page still: the document is the scroll container, so the browser restores a reloaded page's
 * offset itself, with scripts off too. Two small scripts run with scripts on: the one in the
 * head puts a reader's choice of Light or Dark on the root element before the first paint,
 * and the one before the end marker puts the offset back for an engine that restores it late.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <link rel="expect" href="#end-of-page" blocking="render" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: scrollRestoreScript }} />
        <div id="end-of-page" hidden />
      </body>
    </html>
  )
}
