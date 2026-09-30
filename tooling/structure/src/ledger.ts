/** The conformance ledger whose case names must exist in code. */
export const ledgerPath = "docs/verification/01-conformance.md"

const sourceRoots = ["packages/", "examples/", "apps/", "tooling/"]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Reads the case names a ledger cites: every inline code span that reads as a
 * sentence, starting with two lowercase words and running to at least four.
 * Commands such as `bun run check` are not case names.
 */
export const ledgerCaseNames = (ledger: string): ReadonlyArray<string> => {
  const names = new Set<string>()

  for (const match of ledger.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1] ?? ""
    if (!/^[a-z][a-z'-]* [a-z]/.test(span) || span.startsWith("bun ")) continue
    if (span.split(" ").length >= 4) names.add(span)
  }

  return [...names]
}

/**
 * Returns the ledger's case names that no source file declares. A case is
 * declared by a string literal equal to its name or ending in a space and its
 * name, so suite prefixes such as `workflows: ` still match, or by a template
 * literal whose interpolations stand for any text and whose longest literal
 * part has at least 12 characters, so `${flavor}: …` and `across ${point}
 * crashes` match their expansions. Sources are TypeScript files under the
 * workspace roots, excluding this checker, whose tests hold made-up names.
 */
export const unknownLedgerCases = (input: {
  readonly ledger: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
}): ReadonlyArray<string> => {
  const literals: Array<string> = []
  const templates: Array<RegExp> = []

  for (const file of input.files) {
    if (!/\.tsx?$/.test(file.path)) continue
    if (!sourceRoots.some((root) => file.path.startsWith(root))) continue
    if (file.path.startsWith("tooling/structure/")) continue

    for (const match of file.text.matchAll(
      /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
    )) {
      const template = match[3]

      if (template === undefined || !template.includes("${")) {
        literals.push(match[1] ?? match[2] ?? template ?? "")
        continue
      }

      const parts = template.split(/\$\{[^}]*\}/)
      if (Math.max(...parts.map((part) => part.length)) < 12) continue
      templates.push(new RegExp(`^${parts.map(escape).join(".+")}$`))
    }
  }

  return ledgerCaseNames(input.ledger).filter(
    (name) =>
      !literals.some((literal) => literal === name || literal.endsWith(` ${name}`)) &&
      !templates.some((template) => template.test(name) || template.test(`x: ${name}`)),
  )
}
