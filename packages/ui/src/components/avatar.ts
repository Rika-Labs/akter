import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { colors, dimensions, radius, typography } from "../tokens.stylex.ts"

const styles = stylex.create({
  root: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    fontWeight: typography.weightMedium,
    letterSpacing: "0.02em",
    userSelect: "none",
  },
  sm: { width: dimensions.avatar, height: dimensions.avatar, fontSize: "0.625rem" },
  lg: { width: dimensions.avatarLg, height: dimensions.avatarLg, fontSize: typography.caption },
  square: { borderRadius: radius.sm },
  quiet: { backgroundColor: colors.selected, color: colors.foreground },
})

/** Initials from a display name: the first letter of the first two words. */
export const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase())
    .join("")

/** A person or an organization. Organizations are square so they never read as people. */
export type AvatarConfig<Message> = SlotConfig<Message> &
  Readonly<{
    name: string
    size?: "sm" | "lg"
    kind?: "person" | "organization"
    tone?: "ink" | "quiet"
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: AvatarConfig<Message>): Html =>
  h.span(
    [
      h.AriaHidden(true),
      h.DataAttribute("slot", "avatar"),
      ...(config.attributes ?? []),
      ...styleAttributes(
        h,
        styles.root,
        styles[config.size ?? "sm"],
        config.kind === "organization" && styles.square,
        config.tone === "quiet" && styles.quiet,
        config.style,
      ),
    ],
    [initials(config.name)],
  )

/** Initials in a small ink disc; decorative, so pair it with the visible name. */
export const avatar: {
  <Message>(h: HtmlBuilder<Message>, config: AvatarConfig<Message>): Html
  <Message>(config: AvatarConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
