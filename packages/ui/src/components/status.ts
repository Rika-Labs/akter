import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, conditions, dimensions, motion, radius, space } from "../tokens.stylex.ts"

/**
 * What a status means, not what colour it is. Most states are ink: a filled dot is running or live,
 * a hollow muted dot is idle or done, a hollow ink dot needs a look. Colour is reserved for failure
 * and warning so it still means something.
 */
export type StatusTone =
  | "live"
  | "idle"
  | "attention"
  | "pending"
  | "success"
  | "warning"
  | "danger"

const pulse = stylex.keyframes({
  "0%": { boxShadow: `0 0 0 0 ${colors.ring}` },
  "70%": { boxShadow: "0 0 0 5px transparent" },
  "100%": { boxShadow: "0 0 0 0 transparent" },
})

const styles = stylex.create({
  status: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    whiteSpace: "nowrap",
    color: colors.foreground,
  },
  quiet: { color: colors.mutedForeground },
  dot: {
    display: "inline-block",
    flexShrink: 0,
    width: dimensions.dot,
    height: dimensions.dot,
    borderRadius: radius.full,
    borderWidth: borders.strong,
    borderStyle: "solid",
    borderColor: "transparent",
  },
  live: { backgroundColor: colors.foreground, borderColor: colors.foreground },
  idle: { borderColor: colors.subtleForeground },
  attention: { borderColor: colors.foreground },
  pending: {
    backgroundColor: colors.foreground,
    borderColor: colors.foreground,
    animationName: { default: pulse, [conditions.reducedMotion]: "none" },
    animationDuration: motion.pulse,
    animationIterationCount: "infinite",
  },
  success: { backgroundColor: colors.success, borderColor: colors.success },
  warning: { backgroundColor: colors.warning, borderColor: colors.warning },
  danger: { backgroundColor: colors.destructive, borderColor: colors.destructive },
})

/** A status dot alone, for lists that already say the word elsewhere. */
export const statusDot: {
  <Message>(h: HtmlBuilder<Message>, tone: StatusTone): Html
  (tone: StatusTone): <Message>(h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, tone: StatusTone): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.DataAttribute("tone", tone),
      ...styleAttributes(h, styles.dot, styles[tone]),
    ],
    [],
  ),
)

/** A status: a small dot and one word. */
export type StatusConfig<Message> = SlotConfig<Message> &
  Readonly<{
    tone: StatusTone
    label: string
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: StatusConfig<Message>): Html =>
  h.span(
    [
      h.DataAttribute("slot", "status"),
      h.DataAttribute("tone", config.tone),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.status, config.tone === "idle" && styles.quiet, config.style),
    ],
    [statusDot(h, config.tone), config.label],
  )

/** A status as a dot plus a word, the only status treatment in the console. */
export const status: {
  <Message>(h: HtmlBuilder<Message>, config: StatusConfig<Message>): Html
  <Message>(config: StatusConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
