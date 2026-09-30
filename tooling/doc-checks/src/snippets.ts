import { Schema } from "effect"

/**
 * Globs, relative to the repository root, of the documents whose TypeScript
 * examples must typecheck.
 */
export const snippetSources = ["README.md", "docs/api/*.md", "docs/vision/*.md"] as const

/** A fenced TypeScript example and the hidden setup that makes it a module. */
export interface Snippet {
  /** 1-based line of the opening fence in the document. */
  readonly line: number
  /** Module path the example is written to, when other examples import it. */
  readonly file: string | undefined
  /** Hidden code placed before the example: imports and declarations it assumes. */
  readonly prelude: string
  readonly code: string
}

/** A hidden module an example imports, such as `./room/contract.ts`. */
export interface SnippetModule {
  readonly line: number
  readonly file: string
  readonly code: string
}

/** Every checked example, hidden module, and target-API example in one document. */
export interface DocumentSnippets {
  readonly snippets: ReadonlyArray<Snippet>
  readonly modules: ReadonlyArray<SnippetModule>
  /** Opening-fence lines of examples marked `target`: API not implemented yet. */
  readonly targets: ReadonlyArray<number>
}

/** A `<!-- snippet -->` comment that does not match the grammar `parseSnippets` reads. */
export class SnippetMarkerInvalid extends Schema.TaggedError<SnippetMarkerInvalid>()(
  "SnippetMarkerInvalid",
  { line: Schema.Int, reason: Schema.String },
) {}

const typescriptFence = /^(`{3,}|~{3,})(ts|typescript|tsx)\b/

const anyFence = /^(`{3,}|~{3,})/

const markerStart = /^<!-- snippet(?:\s+(.*?))?\s*(-->)?\s*$/

const modulePath = /^[a-z0-9][a-z0-9/_.-]*\.tsx?$/i

interface Marker {
  readonly line: number
  readonly target: boolean
  readonly file: string | undefined
  readonly module: string | undefined
  readonly body: string
}

const parseMarker = (line: number, header: string, body: string) => {
  let target = false
  let file: string | undefined
  let module: string | undefined

  for (const token of header.split(/\s+/).filter((part) => part !== "")) {
    if (token === "target") target = true
    else if (token.startsWith("file=")) file = token.slice("file=".length)
    else if (token.startsWith("module=")) module = token.slice("module=".length)
    else throw SnippetMarkerInvalid.make({ line, reason: `unknown directive ${token}` })
  }

  for (const path of [file, module])
    if (path !== undefined && (!modulePath.test(path) || path.split("/").includes("..")))
      throw SnippetMarkerInvalid.make({ line, reason: `invalid module path ${path}` })

  if (module !== undefined && (target || file !== undefined))
    throw SnippetMarkerInvalid.make({ line, reason: "module= stands alone" })

  if (target && (file !== undefined || body.trim() !== ""))
    throw SnippetMarkerInvalid.make({ line, reason: "target takes no file or prelude" })

  return { line, target, file, module, body } satisfies Marker
}

/**
 * Reads the TypeScript examples of one Markdown document.
 *
 * Each fenced `ts` block is a module on its own. An HTML comment directly
 * above a block, `<!-- snippet file=<path>` followed by prelude lines and
 * `-->`, names the module other blocks import and hides the imports and
 * declarations the example assumes; `<!-- snippet target -->` marks an example
 * of API that is not implemented, which is not checked. A comment
 * `<!-- snippet module=<path>` whose lines are a whole module defines a hidden
 * module that examples import. Comments are invisible on GitHub and the docs
 * site, so the example readers see stays short while the checked module is
 * complete. Throws `SnippetMarkerInvalid` for a malformed comment or one that
 * is not followed by a TypeScript block.
 */
export const parseSnippets = (markdown: string): DocumentSnippets => {
  const lines = markdown.split("\n")
  const snippets: Array<Snippet> = []
  const modules: Array<SnippetModule> = []
  const targets: Array<number> = []
  let pending: Marker | undefined
  let index = 0

  while (index < lines.length) {
    const text = lines[index] ?? ""
    const line = index + 1
    const marker = markerStart.exec(text)

    if (marker !== null) {
      if (pending !== undefined)
        throw SnippetMarkerInvalid.make({
          line: pending.line,
          reason: "not followed by a TypeScript block",
        })

      const body: Array<string> = []
      index += 1

      if (marker[2] === undefined) {
        while (index < lines.length && lines[index]?.trim() !== "-->") {
          body.push(lines[index] ?? "")
          index += 1
        }

        if (index >= lines.length)
          throw SnippetMarkerInvalid.make({ line, reason: "comment is never closed" })

        index += 1
      }

      const parsed = parseMarker(line, marker[1] ?? "", body.join("\n"))

      if (parsed.module === undefined) pending = parsed
      else modules.push({ line, file: parsed.module, code: parsed.body })

      continue
    }

    const fence = anyFence.exec(text)

    if (fence === null) {
      if (pending !== undefined && text.trim() !== "")
        throw SnippetMarkerInvalid.make({
          line: pending.line,
          reason: "not followed by a TypeScript block",
        })

      index += 1
      continue
    }

    const typescript = typescriptFence.test(text)
    const close = fence[1] ?? ""
    const code: Array<string> = []
    index += 1

    while (index < lines.length && !(lines[index] ?? "").startsWith(close)) {
      code.push(lines[index] ?? "")
      index += 1
    }

    index += 1

    if (!typescript) {
      if (pending !== undefined)
        throw SnippetMarkerInvalid.make({
          line: pending.line,
          reason: "not followed by a TypeScript block",
        })

      continue
    }

    if (pending?.target === true) targets.push(line)
    else
      snippets.push({
        line,
        file: pending?.file,
        prelude: pending?.body ?? "",
        code: code.join("\n"),
      })

    pending = undefined
  }

  if (pending !== undefined)
    throw SnippetMarkerInvalid.make({
      line: pending.line,
      reason: "not followed by a TypeScript block",
    })

  return { snippets, modules, targets }
}

/** A generated module and how its lines map back to the document. */
export interface GeneratedFile {
  readonly path: string
  readonly text: string
  /** Document line of each generated line, or `undefined` for prelude lines. */
  readonly documentLines: ReadonlyArray<number | undefined>
}

/**
 * Turns one document's examples into module files under a directory named
 * after the document. Every file ends with `export {}`, so examples that
 * declare the same names do not collide.
 */
export const generateFiles = (input: {
  readonly source: string
  readonly parsed: DocumentSnippets
}) => {
  const { source, parsed } = input
  const directory = source.replace(/\.md$/, "").replaceAll("/", "__")

  const files: Array<GeneratedFile> = []

  for (const module of parsed.modules) {
    const moduleLines = module.code.split("\n")

    files.push({
      path: `${directory}/${module.file}`,
      text: `${module.code}\nexport {}\n`,
      documentLines: moduleLines.map((_, offset) => module.line + 1 + offset),
    })
  }

  for (const snippet of parsed.snippets) {
    const preludeLines = snippet.prelude === "" ? [] : snippet.prelude.split("\n")
    const codeLines = snippet.code.split("\n")

    files.push({
      path: `${directory}/${snippet.file ?? `snippet-line-${snippet.line}.ts`}`,
      text: [...preludeLines, ...codeLines, "export {}", ""].join("\n"),
      documentLines: [
        ...preludeLines.map(() => undefined),
        ...codeLines.map((_, offset) => snippet.line + 1 + offset),
      ],
    })
  }

  return files
}
