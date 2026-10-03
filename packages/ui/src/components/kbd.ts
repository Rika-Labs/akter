import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, radius, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  group: { display: "inline-flex", alignItems: "center", gap: space.xxs },
  key: {
    display: "inline-grid",
    placeItems: "center",
    minWidth: "1.125rem",
    height: "1.125rem",
    paddingInline: space.xs,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.xs,
    backgroundColor: colors.card,
    color: colors.mutedForeground,
    fontFamily: typography.sans,
    fontSize: typography.micro,
    fontWeight: typography.weightMedium,
    lineHeight: 1,
  },
})

/** The keys of one shortcut, such as `["⌘", "K"]`. */
export type KbdConfig<Message> = SlotConfig<Message> & Readonly<{ keys: ReadonlyArray<string> }>

const render = <Message>(h: HtmlBuilder<Message>, config: KbdConfig<Message>): Html =>
  h.kbd(
    [
      h.DataAttribute("slot", "kbd"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.group, config.style),
    ],
    config.keys.map((key) => h.kbd([...styleAttributes(h, styles.key)], [key])),
  )

/** A keyboard shortcut hint. */
export const kbd: {
  <Message>(h: HtmlBuilder<Message>, config: KbdConfig<Message>): Html
  <Message>(config: KbdConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
