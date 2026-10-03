import type { ThemeRegistration } from "shiki"

const INK = "#0b0d0b"
const BODY = "#0b0d0bcc"
const QUIET = "#0b0d0b8c"
const FAINT = "#0b0d0b66"
const WARM = "#6b5e3c"

/**
 * The code theme: ink on stone, with a warm brown for literals and a quiet grey for punctuation
 * and comments. Hierarchy comes from weight and tone rather than hue, to match the brand's single
 * ink. Colours are fixed because the website is light-only.
 */
export const inkStoneTheme: ThemeRegistration = {
  name: "akter-ink-stone",
  type: "light",
  colors: { "editor.background": "#f7f6f3", "editor.foreground": BODY },
  tokenColors: [
    { settings: { foreground: BODY } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: FAINT } },
    {
      scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"],
      settings: { foreground: INK, fontStyle: "bold" },
    },
    {
      scope: ["keyword.operator", "punctuation", "meta.brace", "meta.delimiter"],
      settings: { foreground: QUIET },
    },
    {
      scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"],
      settings: { foreground: WARM },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: WARM },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
      ],
      settings: { foreground: INK },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.class",
        "support.type",
        "entity.other.inherited-class",
      ],
      settings: { foreground: INK },
    },
    {
      scope: ["variable.other.property", "meta.object-literal.key", "support.type.property-name"],
      settings: { foreground: INK },
    },
    {
      scope: ["entity.name.command", "support.function.builtin.shell"],
      settings: { foreground: INK, fontStyle: "bold" },
    },
    {
      scope: ["constant.other.option", "string.unquoted.argument"],
      settings: { foreground: WARM },
    },
    {
      scope: ["markup.heading", "entity.name.section"],
      settings: { foreground: INK, fontStyle: "bold" },
    },
    { scope: ["markup.deleted"], settings: { foreground: "#a3352a" } },
    { scope: ["markup.inserted"], settings: { foreground: "#2f6b4f" } },
  ],
}
