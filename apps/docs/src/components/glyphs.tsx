import type { SVGProps } from "react"

type GlyphProps = SVGProps<SVGSVGElement>

/**
 * The drawing every glyph here shares: a 24-unit grid, a 2-unit round stroke and no fill, sized
 * by the stylesheet of whatever holds it.
 */
function Glyph(props: GlyphProps) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  )
}

export const SearchGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.95-3.95" />
  </Glyph>
)

export const ExternalGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <path d="M6.25 17.75 18 6M9 6h9v9" />
  </Glyph>
)

export const CheckGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <path d="M5 12.75 10 19 19 5" />
  </Glyph>
)

export const CopyGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <path d="M15 9V5.25A2.25 2.25 0 0 0 12.75 3h-7.5A2.25 2.25 0 0 0 3 5.25v7.5A2.25 2.25 0 0 0 5.25 15H9" />
    <rect x="9" y="9" width="12" height="12" rx="2.25" />
  </Glyph>
)

export const SunGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <circle cx="12" cy="12" r="5" />
    <path d="M12 3V2M12 22v-1M18.36 5.64l.71-.71M4.93 19.07l.71-.71M21 12h1M2 12h1M18.36 18.36l.71.71M4.93 4.93l.71.71" />
  </Glyph>
)

export const SystemGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <rect x="3" y="5" width="18" height="12" rx="3" />
    <path d="M9 17v3h6v-3" strokeLinecap="square" />
  </Glyph>
)

export const NavGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M11 5v14" strokeLinecap="square" />
    <circle cx="7" cy="8.75" r=".4" fill="currentColor" />
    <circle cx="7" cy="12" r=".4" fill="currentColor" />
    <circle cx="7" cy="15.25" r=".4" fill="currentColor" />
  </Glyph>
)

export const GrabberGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <path d="M8 9l4-3.4L16 9M8 15l4 3.4L16 15" />
  </Glyph>
)

export const LinkGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <g transform="translate(12 12) scale(.93) translate(-12 -12)" strokeWidth={2.15}>
      <path d="M13 18l-1.38 1.38a3.5 3.5 0 0 1-4.95 0l-2.76-2.76a3.5 3.5 0 0 1 0-4.95L6 11M11 6l1.38-1.38a3.5 3.5 0 0 1 4.95 0l2.76 2.76a3.5 3.5 0 0 1 0 4.95L18 13M9 15l6-6" />
    </g>
  </Glyph>
)

export const BookGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <path d="M5 19V5a2 2 0 0 1 2-2h9a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a2 2 0 0 1-2-2zm0 0a2 2 0 0 1 2-2h12v-3" />
  </Glyph>
)

export const ApiGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m10 9.5-1.8 1.8a1 1 0 0 0 0 1.4l1.8 1.8M14 9.5l1.8 1.8a1 1 0 0 1 0 1.4L14 14.5" />
  </Glyph>
)

export const BoltGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <path d="M13 1.75 4 14.8h7v7.45l9-13.05h-7z" />
  </Glyph>
)

export const RocketGlyph = (props: GlyphProps) => (
  <Glyph {...props}>
    <g transform="translate(11.5 13) scale(.92) translate(-12 -12)" strokeWidth={2.17}>
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" />
      <path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" />
    </g>
  </Glyph>
)
