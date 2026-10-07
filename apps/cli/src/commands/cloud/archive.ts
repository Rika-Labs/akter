import { Effect, FileSystem, Option, Schema } from "effect"
import { gzipSync } from "node:zlib"

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
 * A path inside the build context as the control plane accepts it:
 * relative, `/`-separated, with `.` and empty segments dropped. A path that
 * starts at `/` or climbs out with `..` names nothing inside the context.
 */
export const contextPath = (path: string) => {
  const segments = path.replaceAll("\\", "/").split("/")

  if (path.startsWith("/") || segments.includes("..")) return Option.none()

  const kept = segments.filter((segment) => segment !== "" && segment !== ".").join("/")

  return kept === "" ? Option.none() : Option.some(kept)
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

/** One tar entry: a regular file with its permission bits, or a symbolic link with its target. */
type Entry =
  | { readonly path: string; readonly mode: number; readonly bytes: Uint8Array }
  | { readonly path: string; readonly target: string }

const BLOCK = 512

const encoder = new TextEncoder()

/** `value` as a zero-padded octal field of `width` bytes, its last byte NUL. */
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`

/**
 * One ustar header. A path or link target too long for its field, or not
 * ASCII, is carried by a PAX extended header in front of it, which every
 * tar reader Docker uses understands.
 */
const headers = (entry: {
  readonly path: string
  readonly mode: number
  readonly size: number
  readonly type: "0" | "2" | "x"
  readonly target: string
}): ReadonlyArray<Uint8Array> => {
  const fits = (value: string) =>
    encoder.encode(value).byteLength <= 100 && /^[\x20-\x7e]*$/u.test(value)
  const extended =
    entry.type !== "x" && (!fits(entry.path) || !fits(entry.target))
      ? pax(
          [
            ["path", entry.path],
            ["linkpath", entry.target],
          ].filter(([, value]) => value !== ""),
        )
      : []
  const header = new Uint8Array(BLOCK)
  const put = (offset: number, value: string) =>
    header.set(encoder.encode(value).subarray(0, value.length), offset)

  put(0, extended.length > 0 ? entry.path.slice(0, 99).replace(/[^\x20-\x7e]/gu, "_") : entry.path)
  put(100, octal(entry.mode, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(entry.size, 12))
  put(136, octal(0, 12))
  put(148, "        ")
  put(156, entry.type)
  put(157, extended.length > 0 ? "" : entry.target)
  put(257, "ustar\0")
  put(263, "00")
  put(
    148,
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
  )

  return [...extended, header]
}

/** A PAX extended header and its padded records: each `<length> <key>=<value>\n`, the length counting itself. */
const pax = (records: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<Uint8Array> => {
  const body = encoder.encode(
    records
      .map(([key, value]) => {
        const line = ` ${key}=${value}\n`
        const size = encoder.encode(line).byteLength
        let digits = 1

        while (String(size + digits).length !== digits) digits += 1

        return `${size + digits}${line}`
      })
      .join(""),
  )

  return [
    ...headers({
      path: "././@PaxHeader",
      mode: 0o644,
      size: body.byteLength,
      type: "x",
      target: "",
    }),
    padded(body),
  ]
}

const padded = (bytes: Uint8Array) => {
  const block = new Uint8Array(Math.ceil(bytes.byteLength / BLOCK) * BLOCK)

  block.set(bytes)

  return block
}

/**
 * A gzip-compressed tar of `entries`, in order. Owners and times are zeroed,
 * so the same files always pack to the same bytes and the same digest.
 */
const tar = (entries: ReadonlyArray<Entry>) => {
  const blocks = entries.flatMap((entry) =>
    "target" in entry
      ? headers({ path: entry.path, mode: 0o777, size: 0, type: "2", target: entry.target })
      : [
          ...headers({
            path: entry.path,
            mode: entry.mode,
            size: entry.bytes.byteLength,
            type: "0",
            target: "",
          }),
          padded(entry.bytes),
        ],
  )
  const bytes = new Uint8Array(
    blocks.reduce((size, block) => size + block.byteLength, 0) + 2 * BLOCK,
  )
  let offset = 0

  for (const block of blocks) {
    bytes.set(block, offset)
    offset += block.byteLength
  }

  return gzipSync(bytes)
}

/**
 * Packs a build context the way `docker build` would send it: every file
 * under `context` that its ignore file keeps, as a gzip-compressed tar with
 * `/`-separated paths in sorted order. The ignore file is `<dockerfile>.dockerignore`
 * when it exists, as BuildKit reads it, otherwise `.dockerignore`. The
 * Dockerfile, a path `contextPath` accepted, is always included and must be
 * a regular file. A symbolic link is sent as a link, never followed, so
 * nothing it points at outside the context is read and a link loop cannot
 * recurse. Files keep their permission bits; owners and times are zeroed.
 */
export const packContext = (input: { readonly context: string; readonly dockerfile: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = input.context.replace(/[\\/]+$/u, "")
    const dockerfile = input.dockerfile
    const ignoreFile = [`${dockerfile}.dockerignore`, ".dockerignore"]
    let rules: ReadonlyArray<Rule> = []

    for (const candidate of ignoreFile)
      if (yield* fs.exists(`${root}/${candidate}`)) {
        rules = ignoreRules(yield* fs.readFileString(`${root}/${candidate}`))
        break
      }

    const exceptions = rules.filter((rule) => rule.exception)
    const entries: Array<Entry> = []

    const walk = (directory: string): Effect.Effect<void, ContextInvalid, never> =>
      Effect.gen(function* () {
        const names = (yield* fs.readDirectory(
          directory === "" ? root : `${root}/${directory}`,
        )).toSorted()

        for (const name of names) {
          const path = directory === "" ? name : `${directory}/${name}`
          const kept = path === dockerfile || !isIgnored(rules)(path)
          const link = yield* Effect.option(fs.readLink(`${root}/${path}`))

          if (Option.isSome(link)) {
            if (kept) entries.push({ path, target: link.value })
            continue
          }

          const info = yield* fs.stat(`${root}/${path}`)

          if (info.type === "Directory") {
            if (
              !kept &&
              !dockerfile.startsWith(`${path}/`) &&
              !exceptions.some((rule) => reaches(rule, path.split("/")))
            )
              continue

            yield* walk(path)
          } else if (info.type === "File" && kept)
            entries.push({
              path,
              mode: info.mode & 0o777,
              bytes: yield* fs.readFile(`${root}/${path}`),
            })
        }
      }).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            ContextInvalid.make({ message: `Cannot read ${root}/${directory}: ${error.message}` }),
          ),
        ),
      )

    yield* walk("")

    if (!entries.some((entry) => entry.path === dockerfile && !("target" in entry)))
      return yield* ContextInvalid.make({ message: `No Dockerfile at ${root}/${dockerfile}` })

    return { archive: tar(entries), files: entries.map((entry) => entry.path) }
  })
