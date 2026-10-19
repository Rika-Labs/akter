import "./global.css"
import "../../.cache/fonts.css"

import type { Metadata, Viewport } from "next"
import type { ReactNode } from "react"

import { siteUrl } from "../content/build-origins.ts"
import { fontGateScript, fontGateStartScript, fontGateStyle } from "../content/font-gate.ts"
import { scrollRestoreScript } from "../content/scroll-restore-script.ts"
import { siteDescription, siteName } from "../content/site.ts"
import { themeScript } from "../content/theme-script.ts"

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
 * query in CSS, and both fonts are embedded in the render-blocking stylesheet, so the first
 * response carries everything the first paint needs and no font request follows it. The expect
 * link holds the first paint until the parser reaches the end marker, so Chromium never paints
 * a half-parsed page. Neither engine decodes an embedded face before it has laid out text, so a
 * script in the head gates the page (a style hides it) and the font gate script, placed before
 * the marker, opens the gate once both faces are ready. The gate is set by script and not
 * rendered here, so a page that React has to render again never gets it back, and a page without
 * scripts is never gated. Two more scripts run before the first paint: the one in the head
 * puts a reader's choice of Light or Dark on the root element, and the one before the marker
 * owns scroll restoration.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="expect" href="#end-of-page" blocking="render" />
        <style dangerouslySetInnerHTML={{ __html: fontGateStyle }} />
        <script dangerouslySetInnerHTML={{ __html: fontGateStartScript }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: fontGateScript }} />
        <script dangerouslySetInnerHTML={{ __html: scrollRestoreScript }} />
        <div id="end-of-page" hidden />
      </body>
    </html>
  )
}
