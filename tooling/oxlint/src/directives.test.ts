import { expect, it } from "vitest"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"
import { violations } from "./directives.ts"

it("rejects every directive scope and ESLint aliases, including attempts to disable this check", () => {
  for (const prefix of ["oxlint", "eslint"])
    for (const scope of ["", "-line", "-next-line"])
      for (const directive of [`// ${prefix}-disable${scope}`, `/* ${prefix}-disable${scope} */`])
        expect(
          violations({ file: "entry.ts", text: `${directive}\nexport const value = 1` }),
        ).toEqual(["entry.ts:1: Lint disable directives are banned; fix the code instead."])

  expect(
    violations({
      file: "entry.ts",
      text: "/* oxlint-disable */\n// oxlint-disable-next-line no-disable-directives\nconst value = 1",
    }),
  ).toHaveLength(2)
})

it("parses actual comments rather than strings, templates, regexes, or explanatory prose", () => {
  const text = [
    'const string = "// oxlint-disable"',
    "const template = `/* eslint-disable */`",
    "const pattern = /oxlint-disable/",
    "// Explain why oxlint-disable is prohibited.",
    "/* Required license notice. */",
  ].join("\n")

  expect(violations({ file: "entry.ts", text })).toEqual([])
  expect(
    violations({
      file: "entry.tsx",
      text: 'const text = "é"\nconst view = <div />\n/*\n oxlint-disable-next-line no-debugger -- explanation\n*/\ndebugger',
    }),
  ).toEqual(["entry.tsx:3: Lint disable directives are banned; fix the code instead."])
})

it("fails rather than passing source it cannot parse", () => {
  expect(() => violations({ file: "broken.ts", text: "const =" })).toThrow("Cannot check")
})

it("the CLI checks untracked and tracked source, honors gitignore, and fails outside a repository", () => {
  const runtime = ManagedRuntime.make(BunServices.layer)

  return runtime
    .runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const script = new URL("./directives.ts", import.meta.url).pathname
        const run = () => Bun.spawnSync(["bun", script], { cwd: root })

        expect(run().exitCode).not.toBe(0)
        expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0)
        yield* fs.writeFileString(`${root}/.gitignore`, "ignored.ts\n")
        yield* fs.writeFileString(`${root}/ignored.ts`, "/* oxlint-disable */\nconst a = 1")
        yield* fs.writeFileString(`${root}/entry.ts`, 'const text = "// oxlint-disable"')
        expect(run().exitCode).toBe(0)
        yield* fs.writeFileString(`${root}/entry.ts`, "/* oxlint-disable */\nconst a = 1")
        const untracked = run()
        expect(untracked.exitCode).not.toBe(0)
        expect(untracked.stderr.toString()).toContain(
          "entry.ts:1: Lint disable directives are banned",
        )
        expect(Bun.spawnSync(["git", "add", "entry.ts"], { cwd: root }).exitCode).toBe(0)
        expect(run().exitCode).not.toBe(0)
        yield* fs.remove(`${root}/entry.ts`)
        expect(run().exitCode).toBe(0)
      }).pipe(Effect.scoped),
    )
    .finally(() => runtime.dispose())
})
