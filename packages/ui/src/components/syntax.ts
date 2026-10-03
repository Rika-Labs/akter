/** Languages the light highlighter understands; anything else renders as plain text. */
export type Language = "json" | "typescript" | "shell" | "log" | "text"

/** What a run of characters is, so a renderer can give it one quiet treatment. */
export type TokenKind =
  | "plain"
  | "key"
  | "string"
  | "number"
  | "keyword"
  | "comment"
  | "prompt"
  | "ok"

/** A run of characters and its kind. */
export interface Token {
  readonly kind: TokenKind
  readonly text: string
}

const keywords = new Set([
  "const",
  "let",
  "import",
  "from",
  "export",
  "await",
  "yield",
  "function",
  "return",
  "if",
  "else",
  "new",
  "type",
  "interface",
  "class",
  "extends",
  "true",
  "false",
  "null",
  "undefined",
])

const patterns = {
  json: /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d[\d.eE+-]*\b)|(\btrue\b|\bfalse\b|\bnull\b)/gu,
  typescript:
    /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|(\b[A-Za-z_$][\w$]*\b)/gu,
  shell: /(^\s*#.*$)|(^\s*\$)|("(?:[^"\\]|\\.)*"|'[^']*')|(\s--?[\w-]+)/gu,
  log: /(^\s*\$)|(\bok\b|\bdone\b|\blive\b)|(\b\d[\d.]*\s?(?:ms|s|GB|MB)\b)/gu,
} as const

const tokenizeLine = (line: string, language: Language): ReadonlyArray<Token> => {
  if (language === "text") return [{ kind: "plain", text: line }]
  const tokens: Array<Token> = []
  let cursor = 0
  const push = (kind: TokenKind, text: string) => {
    if (text.length > 0) tokens.push({ kind, text })
  }
  for (const match of line.matchAll(patterns[language])) {
    const index = match.index
    push("plain", line.slice(cursor, index))
    const [text, first, second, third, fourth] = match
    if (language === "json") {
      if (first !== undefined) {
        push(second === undefined ? "string" : "key", first)
        if (second !== undefined) push("plain", second)
      } else push(third === undefined ? "keyword" : "number", text)
    } else if (language === "typescript") {
      if (first !== undefined) push("comment", text)
      else if (second !== undefined) push("string", text)
      else if (third !== undefined) push("number", text)
      else push(fourth !== undefined && keywords.has(text) ? "keyword" : "plain", text)
    } else if (language === "shell") {
      if (first !== undefined) push("comment", text)
      else if (second !== undefined) push("prompt", text)
      else if (third !== undefined) push("string", text)
      else push("keyword", text)
    } else if (first !== undefined) push("prompt", text)
    else if (second !== undefined) push("ok", text)
    else push("number", text)
    cursor = index + text.length
  }
  push("plain", line.slice(cursor))
  return tokens
}

/**
 * Splits `code` into lines of tokens with a few regular expressions: enough to separate keys,
 * strings, numbers, comments and prompts for a monochrome treatment, without a grammar engine.
 */
export const highlight = (source: Readonly<{ code: string; language: Language }>) =>
  source.code.split("\n").map((line) => tokenizeLine(line, source.language))
