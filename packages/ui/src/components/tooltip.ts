import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { Children, SlotConfig } from "../design/contracts.ts"
import { revealMarker } from "../markers.stylex.ts"
import {
  colors,
  conditions,
  layers,
  motion,
  radius,
  shadows,
  space,
  typography,
} from "../tokens.stylex.ts"

/** Which side of its trigger a tooltip appears on. */
export type TooltipSide = "bottom" | "top" | "right"

const styles = stylex.create({
  anchor: {
    position: "relative",
    display: "inline-flex",
  },
  bubble: {
    position: "absolute",
    zIndex: layers.tooltip,
    pointerEvents: "none",
    whiteSpace: "nowrap",
    paddingBlock: space.xs,
    paddingInline: space.sm,
    borderRadius: radius.xs,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    fontSize: typography.caption,
    fontWeight: typography.weightMedium,
    lineHeight: 1.3,
    boxShadow: shadows.sm,
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", revealMarker)]: 1,
      [stylex.when.ancestor(":focus-within", revealMarker)]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: { default: motion.fast, [conditions.reducedMotion]: motion.instant },
    transitionDelay: {
      default: "0s",
      [stylex.when.ancestor(":hover", revealMarker)]: "350ms",
    },
  },
  bottom: {
    insetBlockStart: `calc(100% + ${space.s})`,
    insetInlineStart: "50%",
    translate: "-50% 0",
  },
  top: { insetBlockEnd: `calc(100% + ${space.s})`, insetInlineStart: "50%", translate: "-50% 0" },
  right: {
    insetInlineStart: `calc(100% + ${space.s})`,
    insetBlockStart: "50%",
    translate: "0 -50%",
  },
})

/**
 * The text bubble alone, for a trigger that already carries `revealMarker` (an icon button). It is
 * hidden from assistive technology: the trigger's own accessible name says the same thing.
 */
export const tooltipBubble: {
  <Message>(h: HtmlBuilder<Message>, config: TooltipBubbleConfig): Html
  <Message>(config: TooltipBubbleConfig): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, config: TooltipBubbleConfig): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.DataAttribute("slot", "tooltip"),
      ...styleAttributes(h, styles.bubble, styles[config.side ?? "bottom"]),
    ],
    [config.label],
  ),
)

/** The bubble's text and side. */
export type TooltipBubbleConfig = Readonly<{ label: string; side?: TooltipSide }>

/** A trigger and the short label shown on hover or keyboard focus. */
export type TooltipConfig<Message> = SlotConfig<Message> &
  TooltipBubbleConfig &
  Readonly<{ children: Children }>

/**
 * Wraps a trigger with a hover and focus tooltip. The label is a visual hint; give the trigger its
 * own accessible name.
 */
export const tooltip: {
  <Message>(h: HtmlBuilder<Message>, config: TooltipConfig<Message>): Html
  <Message>(config: TooltipConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, <Message>(h: HtmlBuilder<Message>, config: TooltipConfig<Message>): Html =>
  h.span(
    [
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.anchor, revealMarker, config.style),
    ],
    [...config.children, tooltipBubble(h, { label: config.label, side: config.side ?? "bottom" })],
  ),
)
