import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { dimensions } from "../tokens.stylex.ts"

/**
 * Line icons drawn on a 16-unit grid with round caps, so every glyph shares one stroke weight.
 * `filled` paths are painted instead of stroked (the GitHub and Google marks, status dots).
 */
const glyphs = {
  overview: { d: "M2.5 7 8 2.5 13.5 7v6.5h-11Z" },
  actors: { d: "M2 6l3-2h9l-3 2Z M2 6h9v7H2Z M11 6l3-2v7l-3 2" },
  commands: { d: "M2.5 4h11 M2.5 8h8 M2.5 12h5" },
  jobs: { d: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z M8 5v3l2 1.5" },
  workflows: {
    d: "M4 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z M5.5 4h3a2 2 0 0 1 2 2v4.5",
  },
  connections: { d: "M4 9a5 5 0 0 1 8 0 M6 11a2.5 2.5 0 0 1 4 0 M2 6.8a8 8 0 0 1 12 0" },
  deployments: { d: "M8 2.5v8 M5 7.5l3 3 3-3 M2.5 13.5h11" },
  regions: {
    d: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z M2.5 8h11 M8 2.5c-2.5 3-2.5 8 0 11 M8 2.5c2.5 3 2.5 8 0 11",
  },
  settings: {
    d: "M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M8 2v1.8 M8 12.2V14 M2 8h1.8 M12.2 8H14 M3.8 3.8l1.3 1.3 M10.9 10.9l1.3 1.3 M3.8 12.2l1.3-1.3 M10.9 5.1l1.3-1.3",
  },
  search: { d: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z M10.5 10.5l3 3" },
  sidebar: {
    d: "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M6 3v10",
  },
  menu: { d: "M2.5 4.5h11 M2.5 8h11 M2.5 11.5h11" },
  user: { d: "M8 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M3 13.5a5 5 0 0 1 10 0" },
  bell: { d: "M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3Z M6.5 14h3" },
  sun: {
    d: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M8 1.5V3 M8 13v1.5 M1.5 8H3 M13 8h1.5 M3.4 3.4l1 1 M11.6 11.6l1 1 M3.4 12.6l1-1 M11.6 4.4l1-1",
  },
  moon: { d: "M12.8 9.6A5.2 5.2 0 0 1 6.4 3.2 5.2 5.2 0 1 0 12.8 9.6Z" },
  monitor: { d: "M2.5 3.5h11v7.5h-11Z M6 13.5h4 M8 11v2.5" },
  environment: {
    d: "M3.5 4h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M5 8h6",
  },
  link: {
    d: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7 M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7",
  },
  key: { d: "M5.5 7.8a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z M7.5 8.5l6-6 M11 5l1.8 1.8" },
  plug: { d: "M6 2.5v3 M10 2.5v3 M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0Z M8 11.5v2" },
  organization: {
    d: "M4 2.5h8a1 1 0 0 1 1 1v10H3v-10a1 1 0 0 1 1-1Z M6 5.5h1 M9 5.5h1 M6 8h1 M9 8h1 M7 13.5V11h2v2.5",
  },
  team: {
    d: "M6 3.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z M2 13a4 4 0 0 1 8 0 M11 4.5a2 2 0 0 1 0 4 M12 9.5a3.5 3.5 0 0 1 2.5 3.5",
  },
  card: {
    d: "M3.5 4h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M2.5 7h11",
  },
  usage: { d: "M3 13V9 M6.5 13V5 M10 13V7.5 M13.5 13V3.5" },
  log: { d: "M4 2.5h6l2.5 2.5v8.5H4Z M6 7.5h4 M6 10h4" },
  profile: {
    d: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z M8 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z M4.4 12.2a4 4 0 0 1 7.2 0",
  },
  plus: { d: "M8 3v10 M3 8h10" },
  minus: { d: "M3 8h10" },
  chevronDown: { d: "M4.5 6.5 8 10l3.5-3.5" },
  chevronUp: { d: "M4.5 9.5 8 6l3.5 3.5" },
  chevronRight: { d: "M6.5 4.5 10 8l-3.5 3.5" },
  chevronLeft: { d: "M9.5 4.5 6 8l3.5 3.5" },
  chevronUpDown: { d: "M5 6l3-3 3 3 M5 10l3 3 3-3" },
  arrowLeft: { d: "M13 8H3.5 M7 4.5 3.5 8 7 11.5" },
  arrowRight: { d: "M3 8h9.5 M9 4.5l3.5 3.5L9 11.5" },
  external: { d: "M6 3.5H3.5v9h9V10 M9 3h4v4 M13 3 7.5 8.5" },
  check: { d: "M3.5 8.5 6.5 11.5 12.5 4.5" },
  close: { d: "M4 4l8 8 M12 4l-8 8" },
  more: { d: "M3.5 8h.01 M8 8h.01 M12.5 8h.01" },
  copy: { d: "M5.5 5.5h7v7h-7Z M10.5 5.5v-2h-7v7h2" },
  pause: { d: "M5.5 3.5v9 M10.5 3.5v9" },
  play: { d: "M5 3.5v9l7.5-4.5Z" },
  retry: { d: "M13 8a5 5 0 1 1-1.5-3.6 M13 2.5v2.5h-2.5" },
  trash: { d: "M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5 M7 7v3.5 M9 7v3.5" },
  eye: {
    d: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  },
  filter: { d: "M2.5 3.5h11l-4.3 5v4l-2.4 1v-5Z" },
  terminal: {
    d: "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M5 6.5l2 1.5-2 1.5 M8.5 10.5h2.5",
  },
  database: {
    d: "M8 2.5c3 0 5 .9 5 2v7c0 1.1-2 2-5 2s-5-.9-5-2v-7c0-1.1 2-2 5-2Z M3 4.5c0 1.1 2 2 5 2s5-.9 5-2 M3 8c0 1.1 2 2 5 2s5-.9 5-2",
  },
  server: {
    d: "M3.5 3h9a1 1 0 0 1 1 1v2.5h-11V4a1 1 0 0 1 1-1Z M2.5 6.5h11V9h-11Z M2.5 9h11v2.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z M5 4.8h.01 M5 7.8h.01 M5 10.8h.01",
  },
  mail: { d: "M2.5 4h11v8.5h-11Z M2.5 4.5 8 9l5.5-4.5" },
  logout: { d: "M6.5 13.5h-3v-11h3 M10 5l3 3-3 3 M13 8H6.5" },
  command: {
    d: "M6 6V4.5A1.5 1.5 0 1 0 4.5 6H11.5A1.5 1.5 0 1 0 10 4.5v7A1.5 1.5 0 1 0 11.5 10h-7A1.5 1.5 0 1 0 6 11.5Z",
  },
  clock: { d: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z M8 5v3h2.5" },
  timer: { d: "M8 4a5 5 0 1 0 0 10A5 5 0 0 0 8 4Z M8 6.5V9l1.5 1 M6.5 1.5h3 M12.2 4.3l1-1" },
  pin: { d: "M6 2.5h4 M7 2.5v4L4.5 9h7L9 6.5v-4 M8 9v4.5" },
  slack: { d: "M6 2.5v11 M10 2.5v11 M2.5 6h11 M2.5 10h11" },
  datadog: { d: "M2.5 13.5h11 M4 11l2.5-3.5 2.5 2 3-5" },
  telemetry: {
    d: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M8 2.5V1 M13.5 8H15",
  },
  pager: {
    d: "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M6 6v5 M6 6h2.2a1.6 1.6 0 0 1 0 3.2H6",
  },
  github: {
    d: "M8 1.3a6.7 6.7 0 0 0-2.1 13c.3.1.5-.1.5-.3v-1.2c-1.9.4-2.3-.8-2.3-.8-.3-.8-.8-1-.8-1-.6-.4 0-.4 0-.4.7 0 1 .7 1 .7.6 1 1.6.7 2 .6.1-.4.2-.7.4-.9-1.5-.2-3-.7-3-3.3 0-.7.3-1.3.7-1.8-.1-.2-.3-.9.1-1.8 0 0 .6-.2 1.8.7a6.3 6.3 0 0 1 3.4 0c1.3-.9 1.8-.7 1.8-.7.4.9.1 1.6.1 1.8.4.5.7 1.1.7 1.8 0 2.6-1.6 3.1-3.1 3.3.2.2.5.6.5 1.2v1.8c0 .2.1.4.5.3A6.7 6.7 0 0 0 8 1.3Z",
    filled: true,
  },
  google: {
    d: "M15.5 8.2c0-.6-.1-1.1-.2-1.6H8v3h4.2a3.6 3.6 0 0 1-1.6 2.4v2h2.6c1.5-1.4 2.3-3.4 2.3-5.8ZM8 16c2.2 0 4-.7 5.3-2l-2.6-2c-.7.5-1.6.8-2.7.8-2.1 0-3.9-1.4-4.5-3.3H.8v2A8 8 0 0 0 8 16ZM3.5 9.5a4.8 4.8 0 0 1 0-3V4.4H.8a8 8 0 0 0 0 7.2l2.7-2.1ZM8 3.2c1.2 0 2.3.4 3.1 1.2l2.3-2.3A8 8 0 0 0 .8 4.4l2.7 2.1C4.1 4.6 5.9 3.2 8 3.2Z",
    filled: true,
  },
} as const

/** Every icon the design system draws. */
export type IconName = keyof typeof glyphs

const styles = stylex.create({
  root: {
    display: "block",
    flexShrink: 0,
    width: dimensions.icon,
    height: dimensions.icon,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  small: { width: dimensions.iconSm, height: dimensions.iconSm },
  filled: { fill: "currentColor", stroke: "none" },
})

/** The icon to draw and its size; icons are decorative unless the caller labels them. */
export type IconConfig<Message> = SlotConfig<Message> &
  Readonly<{
    name: IconName
    size?: "default" | "small"
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: IconConfig<Message>): Html => {
  const glyph: { readonly d: string; readonly filled?: boolean } = glyphs[config.name]
  return h.svg(
    [
      h.ViewBox("0 0 16 16"),
      h.AriaHidden(true),
      h.Attribute("focusable", "false"),
      h.DataAttribute("icon", config.name),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.root,
        config.size === "small" && styles.small,
        glyph.filled === true && styles.filled,
        config.style,
      ),
    ],
    [h.path([h.D(glyph.d)], [])],
  )
}

/** A line icon from the shared set. */
export const icon: {
  <Message>(h: HtmlBuilder<Message>, config: IconConfig<Message>): Html
  <Message>(config: IconConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
