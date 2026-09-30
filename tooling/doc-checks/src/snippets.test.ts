import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  type GeneratedFile,
  generateFiles,
  parseSnippets,
  SnippetMarkerInvalid,
  snippetSources,
} from "./snippets.ts"

const repositoryRoot = new URL("../../..", import.meta.url).pathname

const packageRoot = new URL("..", import.meta.url).pathname

describe("parseSnippets", () => {
  it("reads every TypeScript block as its own module and ignores other languages", () => {
    const parsed = parseSnippets(
      ["# Title", "", "```ts", "const a = 1", "```", "", "```sh", "bun x", "```"].join("\n"),
    )

    expect(parsed.snippets).toEqual([
      { line: 3, file: undefined, prelude: "", code: "const a = 1" },
    ])
    expect(parsed.targets).toEqual([])
  })

  it("attaches a hidden prelude and module path from the comment above a block", () => {
    const parsed = parseSnippets(
      [
        "<!-- snippet file=src/main.ts",
        'import { Counter } from "./counter.ts"',
        "-->",
        "",
        "```ts",
        "Counter.get()",
        "```",
      ].join("\n"),
    )

    expect(parsed.snippets).toEqual([
      {
        line: 5,
        file: "src/main.ts",
        prelude: 'import { Counter } from "./counter.ts"',
        code: "Counter.get()",
      },
    ])
  })

  it("records target blocks without checking them and reads standalone modules", () => {
    const parsed = parseSnippets(
      [
        "<!-- snippet module=room/contract.ts",
        "export const Room = 1",
        "-->",
        "<!-- snippet target -->",
        "```ts",
        "Actor.future()",
        "```",
      ].join("\n"),
    )

    expect(parsed.snippets).toEqual([])
    expect(parsed.targets).toEqual([5])
    expect(parsed.modules).toEqual([
      { line: 1, file: "room/contract.ts", code: "export const Room = 1" },
    ])
  })

  it("rejects a marker that is not directly above a TypeScript block", () => {
    expect(() => parseSnippets("<!-- snippet target -->\n\nprose\n\n```ts\nx\n```")).toThrow(
      SnippetMarkerInvalid,
    )
    expect(() => parseSnippets("<!-- snippet target -->\n```sh\nx\n```")).toThrow(
      SnippetMarkerInvalid,
    )
    expect(() => parseSnippets("<!-- snippet file=../escape.ts -->\n```ts\nx\n```")).toThrow(
      SnippetMarkerInvalid,
    )
    expect(() => parseSnippets("<!-- snippet tagret -->\n```ts\nx\n```")).toThrow(
      SnippetMarkerInvalid,
    )
  })

  it("maps generated lines back to the document and leaves prelude lines unmapped", () => {
    const [file] = generateFiles({
      source: "docs/api/02-context.md",
      parsed: parseSnippets(
        ["<!-- snippet", "declare const x: number", "-->", "```ts", "x + 1", "```"].join("\n"),
      ),
    })

    expect(file?.path).toBe("docs__api__02-context/snippet-line-4.ts")
    expect(file?.text).toBe("declare const x: number\nx + 1\nexport {}\n")
    expect(file?.documentLines.slice(0, 2)).toEqual([undefined, 5])
  })
})

const typecheckTimeout = 600_000

layer(BunServices.layer)("documentation examples", (it) => {
  it.effect(
    "typecheck against the workspace packages",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const outDir = path.join(packageRoot, ".cache", "snippets")

        yield* fs.remove(outDir, { recursive: true, force: true })
        yield* fs.makeDirectory(outDir, { recursive: true })

        const generated = new Map<
          string,
          { readonly source: string; readonly file: GeneratedFile }
        >()

        for (const pattern of snippetSources)
          for (const source of new Bun.Glob(pattern).scanSync(repositoryRoot)) {
            const markdown = yield* fs.readFileString(path.join(repositoryRoot, source))

            for (const file of generateFiles({ source, parsed: parseSnippets(markdown) })) {
              yield* fs.makeDirectory(path.dirname(path.join(outDir, file.path)), {
                recursive: true,
              })
              yield* fs.writeFileString(path.join(outDir, file.path), file.text)
              generated.set(file.path, { source, file })
            }
          }

        expect(generated.size).toBeGreaterThan(0)

        yield* fs.writeFileString(
          path.join(outDir, "tsconfig.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            extends: path.relative(outDir, path.join(repositoryRoot, "tsconfig.json")),
            compilerOptions: { noUnusedLocals: false },
            include: ["**/*.ts"],
          }),
        )

        const tsc = Bun.spawn(
          [path.join(repositoryRoot, "node_modules/.bin/tsc"), "-p", outDir, "--pretty", "false"],
          { cwd: outDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GOMAXPROCS: "1" } },
        )

        const output = yield* Effect.promise(() => new Response(tsc.stdout).text())

        yield* Effect.promise(() => tsc.exited)

        const diagnostics = output
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => {
            const match = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(line)

            if (match === null) return line

            const entry = generated.get(match[1] ?? "")

            if (entry === undefined) return line

            const generatedLine = Number(match[2])
            const documentLine = entry.file.documentLines[generatedLine - 1]

            return documentLine === undefined
              ? `${entry.source} (${entry.file.path} prelude line ${generatedLine}): ${match[4]}`
              : `${entry.source}:${documentLine}: ${match[4]}`
          })

        expect(diagnostics).toEqual([])
      }),
    typecheckTimeout,
  )
})
