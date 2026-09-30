import { evidenceIndex } from "@durable-actors/core/testing"

/** The evidence documents whose case names must exist in code. */
export const ledgerPaths = [
  "docs/verification/01-conformance.md",
  "docs/verification/02-failure-matrix.md",
]

const sourceRoots = ["packages/", "examples/", "apps/", "tooling/"]

const TEST_FILE = /\.(?:test|e2e)\.tsx?$/

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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether a ledger citation names a registered conformance case: exactly, or
 * without the suite prefix, such as `workflows: ` or `payload migrations: `,
 * the case's name carries.
 */
const registeredCase = (registered: ReadonlySet<string>) => {
  const unprefixed = new Set(
    [...registered].flatMap((name) => {
      const prefixed = /^[a-z][\w -]*: (.+)$/i.exec(name)

      return prefixed === null ? [] : [prefixed[1]!]
    }),
  )

  return (name: string) => registered.has(name) || unprefixed.has(name)
}

/**
 * The name patterns a test file declares outside the conformance registry:
 * each whole string literal, and each template literal whose longest literal
 * part has at least 12 characters, with its interpolations standing for any
 * text, because crash, example and browser suites build names in loops over
 * fault points and flavors. Only test files declare names.
 */
const declaredPatterns = (text: string) => {
  const literals: Array<string> = []
  const templates: Array<RegExp> = []

  for (const match of text.matchAll(
    /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g,
  )) {
    const template = match[3]

    if (template === undefined || !template.includes("${")) {
      literals.push(match[1] ?? match[2] ?? template ?? "")
      continue
    }

    const parts = template.split(/\$\{[^}]*\}/)

    if (Math.max(...parts.map((part) => part.length)) >= 12)
      templates.push(new RegExp(`^${parts.map(escape).join(".+")}$`))
  }

  return { literals, templates }
}

/**
 * Returns the ledger's case names that nothing executable declares. A name is
 * declared by a case in the evidence index, which the case registries
 * derive, or by a test file under the workspace roots, as `declaredPatterns`
 * reads it, optionally after a suite prefix such as `workflows: `. Other
 * sources, this checker, and documentation declare nothing.
 */
export const unknownLedgerCases = (input: {
  readonly ledger: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly registered?: ReadonlyArray<string>
}): ReadonlyArray<string> => {
  const inRegistry = registeredCase(
    new Set(input.registered ?? evidenceIndex.map(({ name }) => name)),
  )

  const literals = new Set<string>()
  const templates: Array<RegExp> = []

  for (const file of input.files)
    if (
      TEST_FILE.test(file.path) &&
      sourceRoots.some((root) => file.path.startsWith(root)) &&
      !file.path.startsWith("tooling/structure/")
    ) {
      const declared = declaredPatterns(file.text)

      for (const literal of declared.literals) literals.add(literal)
      templates.push(...declared.templates)
    }

  const declared = (name: string) =>
    literals.has(name) ||
    [...literals].some((literal) => /^[\w-]+: /.test(literal) && literal.endsWith(`: ${name}`)) ||
    templates.some((template) => template.test(name) || template.test(`x: ${name}`))

  return ledgerCaseNames(input.ledger).filter((name) => !inRegistry(name) && !declared(name))
}
