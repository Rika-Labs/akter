import { BunServices } from "@effect/platform-bun"
import { layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  ExampleTitleInvalid,
  type GeneratedFile,
  generateFiles,
  readExamples,
  sketchDocuments,
  snippetSources,
} from "./snippets.ts"

const repositoryRoot = new URL("../../..", import.meta.url).pathname

const packageRoot = new URL("..", import.meta.url).pathname

describe("readExamples", () => {
  it("reads each TypeScript fence as a module, titled or named by its line", () => {
    const examples = readExamples(
      [
        "# Title",
        "",
        '```ts title="src/room.ts"',
        "export const a = 1",
        "```",
        "",
        "```sh",
        "bun x",
        "```",
        "~~~tsx",
        'import { a } from "./src/room.ts"',
        "~~~",
      ].join("\n"),
    )

    expect(examples).toEqual([
      { line: 3, path: "src/room.ts", code: "export const a = 1" },
      { line: 10, path: "line-10.ts", code: 'import { a } from "./src/room.ts"' },
    ])
  })

  it("does not read a TypeScript fence nested inside a longer Markdown fence", () => {
    const examples = readExamples(
      ["````md", "```ts", "not checked", "```", "````", "```ts", "checked", "```"].join("\n"),
    )

    expect(examples).toEqual([{ line: 6, path: "line-6.ts", code: "checked" }])
  })

  it("rejects a title outside the document directory, an unquoted title, and a reused title", () => {
    expect(() => readExamples('```ts title="../escape.ts"\nx\n```')).toThrow(ExampleTitleInvalid)
    expect(() => readExamples("```ts title=room.ts\nx\n```")).toThrow(ExampleTitleInvalid)
    expect(() =>
      readExamples('```ts title="room.ts"\nx\n```\n```ts title="room.ts"\ny\n```'),
    ).toThrow(ExampleTitleInvalid)
  })

  it("names generated files after the document and keeps the fence line for diagnostics", () => {
    const [file] = generateFiles({
      source: "docs/api/02-context.md",
      examples: readExamples("text\n```ts\nconst x: number = 1\n```"),
    })

    expect(file).toEqual({
      path: "docs__api__02-context/line-2.ts",
      text: "const x: number = 1\n",
      source: "docs/api/02-context.md",
      line: 2,
    })
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

        const generated = new Map<string, GeneratedFile>()

        for (const pattern of snippetSources)
          for (const source of new Bun.Glob(pattern).scanSync(repositoryRoot)) {
            if (sketchDocuments.has(source)) continue

            const markdown = yield* fs.readFileString(path.join(repositoryRoot, source))

            for (const file of generateFiles({ source, examples: readExamples(markdown) })) {
              yield* fs.makeDirectory(path.dirname(path.join(outDir, file.path)), {
                recursive: true,
              })
              yield* fs.writeFileString(path.join(outDir, file.path), file.text)
              generated.set(file.path, file)
            }
          }

        expect(generated.size).toBeGreaterThan(0)

        yield* fs.writeFileString(
          path.join(outDir, "tsconfig.json"),
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            extends: path.relative(outDir, path.join(repositoryRoot, "tsconfig.json")),
            compilerOptions: { moduleDetection: "force", noUnusedLocals: false },
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

            const file = generated.get(match[1] ?? "")

            return file === undefined
              ? line
              : `${file.source}:${file.line + Number(match[2])}: ${match[4]}`
          })

        expect(diagnostics).toEqual([])
      }),
    typecheckTimeout,
  )
})
