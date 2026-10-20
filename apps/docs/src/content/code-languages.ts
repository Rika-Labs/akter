const labels = new Map([
  ["bash", "Terminal"],
  ["http", "HTTP"],
  ["javascript", "JavaScript"],
  ["js", "JavaScript"],
  ["json", "JSON"],
  ["jsonc", "JSON"],
  ["markdown", "Markdown"],
  ["plaintext", "Text"],
  ["sh", "Terminal"],
  ["shell", "Terminal"],
  ["sql", "SQL"],
  ["text", "Text"],
  ["ts", "TypeScript"],
  ["tsx", "TSX"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
])

/** The name a code block shows in its header; a language with no entry shows as it is written. */
export const languageLabel = (language: string | undefined): string =>
  language === undefined ? "Text" : (labels.get(language) ?? language)

const LANGUAGE_CLASS = /(?:^|\s)language-(\S+)/

/** The language a highlighted code element names in its class list. */
export const languageOf = (className: string | undefined): string | undefined =>
  className === undefined ? undefined : LANGUAGE_CLASS.exec(className)?.[1]
