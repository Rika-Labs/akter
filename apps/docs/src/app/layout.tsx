import "./global.css"
import "../../.cache/polysans.css"

import { RootProvider } from "fumadocs-ui/provider/next"
import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import type { ReactNode } from "react"

import StaticSearchDialog from "../components/search-dialog.tsx"
import { siteUrl } from "../content/build-origins.ts"
import { fontGateNoScriptStyle, fontGateScript, fontGateStyle } from "../content/font-gate.ts"
import { scrollRestoreScript } from "../content/scroll-restore-script.ts"
import { siteDescription, siteName } from "../content/site.ts"

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
 * PolySans is embedded in the render-blocking stylesheet, which the build writes from the
 * font origin, so the first response already carries everything the first paint needs and no
 * request follows it. The expect link holds the first paint until the parser reaches the end
 * marker, so Chromium never paints a half-parsed page. WebKit does not honour it, so the `html`
 * element starts gated: a style hides the page until the font gate script, placed before the
 * marker, finds PolySans ready and removes the attribute (without a script the page shows at
 * once). The scroll script there restores a reload's position, which WebKit would otherwise
 * do only after the page scripts have loaded.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable} data-font-gate="" suppressHydrationWarning>
      <head>
        <link rel="expect" href="#end-of-page" blocking="render" />
        <style dangerouslySetInnerHTML={{ __html: fontGateStyle }} />
        <noscript>
          <style dangerouslySetInnerHTML={{ __html: fontGateNoScriptStyle }} />
        </noscript>
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider theme={{ enabled: false }} search={{ SearchDialog: StaticSearchDialog }}>
          {children}
        </RootProvider>
        <script dangerouslySetInnerHTML={{ __html: fontGateScript }} />
        <script dangerouslySetInnerHTML={{ __html: scrollRestoreScript }} />
        <div id="end-of-page" hidden />
      </body>
    </html>
  )
}
