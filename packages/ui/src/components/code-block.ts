import * as stylex from "@stylexjs/stylex"
import { Function } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { styleAttributes } from "../design/attributes.ts"
import type { SlotConfig } from "../design/contracts.ts"
import { borders, colors, radius, space, typography } from "../tokens.stylex.ts"
import { iconButton } from "./icon-button.ts"
import { highlight, type Language, type TokenKind } from "./syntax.ts"

const styles = stylex.create({
  root: {
    position: "relative",
    minWidth: 0,
    borderWidth: borders.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.code,
    overflow: "hidden",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    minHeight: "2.25rem",
    paddingInlineStart: "0.875rem",
    paddingInlineEnd: space.xs,
    borderBlockEndWidth: borders.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
    color: colors.mutedForeground,
    fontSize: typography.caption,
  },
  floatingCopy: { position: "absolute", insetBlockStart: space.xs, insetInlineEnd: space.xs },
  pre: {
    margin: 0,
    paddingBlock: space.md,
    paddingInline: "0.875rem",
    overflowX: "auto",
    fontFamily: typography.mono,
    fontSize: "0.78125rem",
    lineHeight: typography.leadingCode,
    color: colors.mutedForeground,
    tabSize: 2,
  },
  small: { fontSize: "0.71875rem" },
  line: { display: "block", minHeight: "1lh", whiteSpace: "pre" },
  plain: {},
  key: { color: colors.syntaxKey, fontWeight: 500 },
  string: { color: colors.syntaxString },
  number: { color: colors.foreground },
  keyword: { color: colors.foreground, fontWeight: 500 },
  comment: { color: colors.syntaxComment },
  prompt: { color: colors.subtleForeground, userSelect: "none" },
  ok: { color: colors.foreground, fontWeight: 600 },
})

const tokenStyles: Readonly<Record<TokenKind, stylex.StyleXStyles>> = {
  plain: styles.plain,
  key: styles.key,
  string: styles.string,
  number: styles.number,
  keyword: styles.keyword,
  comment: styles.comment,
  prompt: styles.prompt,
  ok: styles.ok,
}

/** Code or a log, lightly highlighted. `onCopy` adds a copy button that the caller handles. */
export type CodeBlockConfig<Message> = SlotConfig<Message> &
  Readonly<{
    code: string
    language: Language
    title?: string
    size?: "default" | "small"
    onCopy?: Message
  }>

const render = <Message>(h: HtmlBuilder<Message>, config: CodeBlockConfig<Message>): Html => {
  const copy =
    config.onCopy === undefined
      ? h.empty
      : iconButton(h, { label: "Copy", icon: "copy", onClick: config.onCopy, tooltip: "top" })
  return h.figure(
    [
      h.DataAttribute("slot", "code-block"),
      h.DataAttribute("language", config.language),
      ...(config.attributes ?? []),
      ...styleAttributes(h, styles.root, config.style),
    ],
    [
      config.title === undefined
        ? config.onCopy === undefined
          ? h.empty
          : h.div([...styleAttributes(h, styles.floatingCopy)], [copy])
        : h.figcaption([...styleAttributes(h, styles.head)], [config.title, copy]),
      h.pre(
        [h.Tabindex(0), ...styleAttributes(h, styles.pre, config.size === "small" && styles.small)],
        [
          h.code(
            [],
            highlight({ code: config.code, language: config.language }).map((line) =>
              h.span(
                [...styleAttributes(h, styles.line)],
                line.map((token) =>
                  token.kind === "plain"
                    ? token.text
                    : h.span([...styleAttributes(h, tokenStyles[token.kind])], [token.text]),
                ),
              ),
            ),
          ),
        ],
      ),
    ],
  )
}

/** A code block with light, monochrome syntax highlighting. */
export const codeBlock: {
  <Message>(h: HtmlBuilder<Message>, config: CodeBlockConfig<Message>): Html
  <Message>(config: CodeBlockConfig<Message>): (h: HtmlBuilder<Message>) => Html
} = Function.dual(2, render)
