import { Effect, FileSystem, Schema } from "effect"

/** One `.dockerignore` line: a compiled pattern, its segments, and whether `!` makes it an exception. */
interface Rule {
  readonly exception: boolean
  readonly pattern: RegExp
  readonly segments: ReadonlyArray<string>
}

/** The build context cannot be sent: `message` says why. */
export class ContextInvalid extends Schema.TaggedError<ContextInvalid>()("ContextInvalid", {
  message: Schema.String,
}) {}

/** A cleaned `/`-separated path: no leading `/`, no `.` or empty segments, `..` resolved. */
const clean = (path: string) => {
  const segments: Array<string> = []

  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }

  return segments.join("/")
}

/**
 * Translates a `.dockerignore` pattern into a regular expression the way
 * Docker's pattern matcher does: `*` and `?` stay inside one segment, `**`
 * spans any number of them, and `\` escapes the next character.
 */
const compile = (pattern: string) => {
  let source = "^"

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!

    if (char === "*" && pattern[index + 1] === "*") {
      index++
      if (pattern[index + 1] === "/") index++
      source += index + 1 >= pattern.length ? ".*" : "(.*/)?"
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else if (char === "\\" && index + 1 < pattern.length) {
      index++
      source += `\\${pattern[index]!}`
    } else if (".+()|{}^$".includes(char)) source += `\\${char}`
    else source += char
  }

  return new RegExp(`${source}$`, "u")
}

/** The rules of a `.dockerignore` file's text, in order. */
export const ignoreRules = (text: string): ReadonlyArray<Rule> =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const exception = line.startsWith("!")
      const pattern = clean(exception ? line.slice(1).trim() : line)

      return { exception, pattern: compile(pattern), segments: pattern.split("/") }
    })
    .filter((rule) => rule.segments.join("/") !== "")

/**
 * Whether `path` is left out of the context: the last rule that matches it
 * or one of its parent directories decides, as Docker decides it.
 */
export const isIgnored = (rules: ReadonlyArray<Rule>) => (path: string) => {
  const segments = path.split("/")
  let ignored = false

  for (const rule of rules) {
    if (rule.exception !== ignored) continue

    const matches = segments.some((_, index) =>
      rule.pattern.test(segments.slice(0, index + 1).join("/")),
    )

    if (matches) ignored = !rule.exception
  }

  return ignored
}

/** Whether exception `rule` could match some path inside directory `segments`, so the directory must be walked. */
const reaches = (rule: Rule, segments: ReadonlyArray<string>) => {
  for (const [index, segment] of segments.entries()) {
    const own = rule.segments[index]

    if (own === undefined) return false
    if (own.includes("**")) return true
    if (!compile(own).test(segment)) return false
  }

  return true
}

/**
 * Packs a build context the way `docker build` would send it: every file
 * under `context` that its ignore file keeps, as a gzip-compressed tar with
 * `/`-separated paths in sorted order. The ignore file is `<dockerfile>.dockerignore`
 * when it exists, as BuildKit reads it, otherwise `.dockerignore`. The
 * Dockerfile is always included. Symbolic links are followed, and file
 * modes are not kept.
 */
export const packContext = (input: { readonly context: string; readonly dockerfile: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = input.context.replace(/[\\/]+$/u, "")
    const dockerfile = clean(input.dockerfile)
    const ignoreFile = [`${dockerfile}.dockerignore`, ".dockerignore"]
    let rules: ReadonlyArray<Rule> = []

    for (const candidate of ignoreFile)
      if (yield* fs.exists(`${root}/${candidate}`)) {
        rules = ignoreRules(yield* fs.readFileString(`${root}/${candidate}`))
        break
      }

    const exceptions = rules.filter((rule) => rule.exception)
    const files: Record<string, Uint8Array> = {}

    const walk = (directory: string): Effect.Effect<void, ContextInvalid, never> =>
      Effect.gen(function* () {
        const names = (yield* fs.readDirectory(
          directory === "" ? root : `${root}/${directory}`,
        )).toSorted()

        for (const name of names) {
          const path = directory === "" ? name : `${directory}/${name}`
          const info = yield* fs.stat(`${root}/${path}`)

          if (info.type === "Directory") {
            const segments = path.split("/")

            if (
              isIgnored(rules)(path) &&
              !dockerfile.startsWith(`${path}/`) &&
              !exceptions.some((rule) => reaches(rule, segments))
            )
              continue

            yield* walk(path)
          } else if (info.type === "File" && (path === dockerfile || !isIgnored(rules)(path)))
            files[path] = yield* fs.readFile(`${root}/${path}`)
        }
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            ContextInvalid.make({ message: `Cannot read ${root}/${directory}: ${error.message}` }),
          ),
        ),
      )

    yield* walk("")

    if (files[dockerfile] === undefined)
      return yield* ContextInvalid.make({ message: `No Dockerfile at ${root}/${dockerfile}` })

    const archive = yield* Effect.promise(() =>
      new Bun.Archive(files, { compress: "gzip" }).bytes(),
    )

    return { archive, files: Object.keys(files) }
  })
