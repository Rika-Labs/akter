import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { Children, SlotConfig } from "../design/contracts.ts"
import { colors, space, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  root: {
    display: "grid",
    justifyItems: "center",
    gap: space.md,
    paddingBlock: space.xxxl,
    paddingInline: space.lg,
    textAlign: "center",
  },
  start: { justifyItems: "start", textAlign: "start", paddingInline: 0 },
  art: { width: "100%", maxWidth: "22rem", color: colors.foreground },
  title: { fontSize: "0.9375rem", fontWeight: typography.weightStrong },
  description: { maxWidth: "26rem", color: colors.mutedForeground },
  actions: { display: "flex", gap: space.sm, flexWrap: "wrap", marginBlockStart: space.xs },
})

/** What is missing, what to do about it, and optionally a drawing. */
export type EmptyStateConfig<Message> = SlotConfig<Message> &
  Readonly<{
    title: string
    description?: string
    illustration?: Html
    actions?: Children
    align?: "center" | "start"
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: EmptyStateConfig<Message>): Html =>
  h.div(
    [
      h.DataAttribute("slot", "empty-state"),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.align === "start" && styles.start, config.style),
    ],
    [
      config.illustration === undefined
        ? h.empty
        : h.div([...styleAttributes(h, styles.art)], [config.illustration]),
      h.h2([...styleAttributes(h, styles.title)], [config.title]),
      config.description === undefined
        ? h.empty
        : h.p([...styleAttributes(h, styles.description)], [config.description]),
      config.actions === undefined
        ? h.empty
        : h.div([...styleAttributes(h, styles.actions)], [...config.actions]),
    ],
  )

/** An empty state. */
export const emptyState: {
  <Message>(h: HtmlBuilder<Message>, config: EmptyStateConfig<Message>): Html
  <Message>(config: EmptyStateConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
