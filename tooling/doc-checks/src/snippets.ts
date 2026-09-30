import { Schema } from "effect"

/**
 * Globs, relative to the repository root, of the documents whose TypeScript
 * examples must typecheck.
 */
export const snippetSources = ["README.md", "docs/api/*.md", "docs/vision/*.md"] as const

/**
 * Documents that describe API which does not exist yet. Their examples are
 * proposals, so they are read by people but not typechecked.
 */
export const sketchDocuments: ReadonlySet<string> = new Set([
  "docs/api/post-foundation-sketches.md",
])

/** One fenced TypeScript example: a complete module at `path` within its document. */
export interface Example {
  /** 1-based line of the opening fence in the document. */
  readonly line: number
  /** The fence's `title`, or `line-<line>.ts` for an untitled fence. */
  readonly path: string
  readonly code: string
}

/** A fence `title` that is not a relative `.ts` or `.tsx` path, or that two fences share. */
export class ExampleTitleInvalid extends Schema.TaggedError<ExampleTitleInvalid>()(
  "ExampleTitleInvalid",
  { line: Schema.Int, reason: Schema.String },
) {}

const fenceOpening = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)(.*)$/

const typescript = new Set(["ts", "typescript", "tsx"])

const titleAttribute = /(?:^|\s)title="([^"]*)"/

const modulePath = /^[a-z0-9][a-z0-9/_.-]*\.tsx?$/i

const isClosing = (line: string, opening: string) => {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)

  return match?.[1] !== undefined && match[1][0] === opening[0] && match[1].length >= opening.length
}

const pathOf = (line: number, info: string) => {
  const title = titleAttribute.exec(info)?.[1]

  if (title === undefined) {
    if (info.includes("title="))
      throw ExampleTitleInvalid.make({ line, reason: 'write the title as title="<path>"' })

    return `line-${line}.ts`
  }

  if (!modulePath.test(title) || title.split("/").includes(".."))
    throw ExampleTitleInvalid.make({ line, reason: `${title} is not a relative .ts or .tsx path` })

  return title
}

/**
 * Reads the TypeScript examples of one Markdown document. Each `ts` fence is a
 * complete module whose imports and declarations are all visible to the
 * reader. A fence's standard `title="src/room.ts"` metadata names the module
 * so later fences in the same document can import it.
 */
export const readExamples = (markdown: string): ReadonlyArray<Example> => {
  const lines = markdown.split("\n")
  const examples: Array<Example> = []
  const titled = new Map<string, number>()
  let index = 0

  while (index < lines.length) {
    const opening = fenceOpening.exec(lines[index] ?? "")
    const line = index + 1
    index += 1

    if (opening === null) continue

    const fence = opening[1] ?? ""
    const code: Array<string> = []

    while (index < lines.length && !isClosing(lines[index] ?? "", fence)) {
      code.push(lines[index] ?? "")
      index += 1
    }

    index += 1

    if (!typescript.has(opening[2] ?? "")) continue

    const path = pathOf(line, opening[3] ?? "")
    const earlier = titled.get(path)

    if (earlier !== undefined)
      throw ExampleTitleInvalid.make({ line, reason: `line ${earlier} already defines ${path}` })

    titled.set(path, line)
    examples.push({ line, path, code: code.join("\n") })
  }

  return examples
}

/** An example written as a module under a directory named after its document. */
export interface GeneratedFile {
  readonly path: string
  readonly text: string
  readonly source: string
  /** The document line of the fence; generated line `n` is document line `line + n`. */
  readonly line: number
}

/** Writes each example of `source` to `<source with / as __>/<example path>`. */
export const generateFiles = (input: {
  readonly source: string
  readonly examples: ReadonlyArray<Example>
}): ReadonlyArray<GeneratedFile> => {
  const directory = input.source.replace(/\.md$/, "").replaceAll("/", "__")

  return input.examples.map((example) => ({
    path: `${directory}/${example.path}`,
    text: `${example.code}\n`,
    source: input.source,
    line: example.line,
  }))
}
