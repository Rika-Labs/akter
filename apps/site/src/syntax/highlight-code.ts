import type { ThemedToken } from "shiki"
import { createHighlighter } from "shiki"
import { escapeMarkup } from "../escape-markup.ts"
import { inkStoneTheme } from "./ink-stone-theme.ts"

const LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "json",
  "jsonc",
  "bash",
  "sql",
  "yaml",
  "python",
  "diff",
  "html",
  "css",
  "toml",
] as const

const ALIASES = new Map([
  ["ts", "typescript"],
  ["js", "javascript"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["shellscript", "bash"],
  ["py", "python"],
  ["yml", "yaml"],
])

const BOLD = 2

const highlighter = createHighlighter({ themes: [inkStoneTheme], langs: [...LANGUAGES] })

const known = (language: string): language is (typeof LANGUAGES)[number] =>
  LANGUAGES.some((name) => name === language)

const tokenMarkup = (token: ThemedToken): string => {
  const declarations: Array<string> = []
  if (token.color !== undefined) declarations.push(`color:${token.color}`)
  if (((token.fontStyle ?? 0) & BOLD) !== 0) declarations.push("font-weight:520")
  const content = escapeMarkup(token.content)
  return declarations.length === 0
    ? content
    : `<span style="${declarations.join(";")}">${content}</span>`
}

/**
 * Highlights `code` at build time into the inner markup of a `<code>` element: one `.line` span per
 * line with inline token colours from the ink and stone theme, so pages ship no highlighter. A
 * language the highlighter does not know renders as plain text.
 */
export const highlightCode = async (code: string, language: string): Promise<string> => {
  const resolved = ALIASES.get(language) ?? language
  const instance = await highlighter
  const lang = known(resolved) ? resolved : "text"
  const { tokens } = instance.codeToTokens(code, { lang, theme: inkStoneTheme })

  return tokens.map((line) => `<span>${line.map(tokenMarkup).join("")}</span>`).join("\n")
}
