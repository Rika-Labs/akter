import "./global.css"

import { RootProvider } from "fumadocs-ui/provider/next"
import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import type { ReactNode } from "react"

import StaticSearchDialog from "../components/search-dialog.tsx"
import { polySansUrl, siteUrl } from "../content/build-origins.ts"
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
 * the fonts are preloaded here, so the first byte of HTML already carries everything the
 * first paint needs: no theme script, no late font swap. The font face is written here, not
 * in the stylesheet, because its address depends on the build's font origin. The expect link
 * holds the first paint until the parser reaches the end marker, so Chromium never paints a
 * half-parsed page; the scroll script before the marker restores a reload's position in
 * WebKit, which does not wait for the marker or restore early on its own.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <head>
        <link rel="expect" href="#end-of-page" blocking="render" />
        <style
          dangerouslySetInnerHTML={{
            __html: `@font-face{font-family:"PolySans Var";src:url("${polySansUrl}") format("woff2");font-weight:300 800;font-display:optional}`,
          }}
        />
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
        <script dangerouslySetInnerHTML={{ __html: scrollRestoreScript }} />
        <div id="end-of-page" hidden />
      </body>
    </html>
  )
}
