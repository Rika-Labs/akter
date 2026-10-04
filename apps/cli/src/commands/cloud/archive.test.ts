import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { ContextInvalid, ignoreRules, isIgnored, packContext } from "./archive.ts"

/** A temporary directory holding `files` (path to contents), removed with the scope. */
const context = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()

    for (const [path, contents] of Object.entries(files)) {
      yield* fs.makeDirectory(`${root}/${path.slice(0, path.lastIndexOf("/") + 1)}`, {
        recursive: true,
      })
      yield* fs.writeFileString(`${root}/${path}`, contents)
    }

    return root
  })

/** The archive's paths, sorted, and the text of each file. */
const unpack = (archive: Uint8Array) =>
  Effect.gen(function* () {
    const entries = yield* Effect.promise(() => new Bun.Archive(archive).files())
    const files: Record<string, string> = {}

    for (const [path, file] of [...entries].toSorted(([left], [right]) => (left < right ? -1 : 1)))
      files[path] = yield* Effect.promise(() => file.text())

    return files
  })

layer(BunServices.layer)("build context packing", (it) => {
  it("matches .dockerignore patterns as Docker does: segments, globstars, parent directories and the last matching rule", () => {
    const rules = ignoreRules(
      [
        "# comment",
        "",
        "**/node_modules",
        "/secret.env",
        "*.log",
        "!keep.log",
        "docs/**/draft.md",
        "build?",
        "./tmp/",
      ].join("\n"),
    )
    const ignored = isIgnored(rules)

    expect(ignored("node_modules")).toBe(true)
    expect(ignored("node_modules/pkg/index.js")).toBe(true)
    expect(ignored("apps/web/node_modules/pkg/index.js")).toBe(true)
    expect(ignored("apps/web/node_modules_cache/index.js")).toBe(false)
    expect(ignored("secret.env")).toBe(true)
    expect(ignored("config/secret.env")).toBe(false)
    expect(ignored("error.log")).toBe(true)
    expect(ignored("keep.log")).toBe(false)
    expect(ignored("logs/error.log")).toBe(false)
    expect(ignored("docs/draft.md")).toBe(true)
    expect(ignored("docs/a/b/draft.md")).toBe(true)
    expect(ignored("docs/final.md")).toBe(false)
    expect(ignored("build1/out.js")).toBe(true)
    expect(ignored("build12/out.js")).toBe(false)
    expect(ignored("tmp/scratch")).toBe(true)
    expect(ignored("README.md")).toBe(false)
    expect(isIgnored(ignoreRules("a.b"))("a.b")).toBe(true)
    expect(isIgnored(ignoreRules("a.b"))("aXb")).toBe(false)
  })

  it.effect(
    "packs only what a Dockerfile-specific allow list keeps, never descending into a directory no exception can reach",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* context({
          "package.json": "{}",
          "bun.lock": "lock",
          ".dockerignore": "README.md\n",
          "README.md": "kept by the root ignore file, left out by the runner's",
          "apps/api/package.json": '{"name":"api"}',
          "apps/api/src/server.ts": "server",
          "packages/akter/src/index.ts": "framework",
          "packages/akter/node_modules/dep/index.js": "dependency",
          "infra/local/runner/Dockerfile": "FROM scratch\n",
          "infra/local/runner/main.ts": "runner",
          "infra/local/runner/Dockerfile.dockerignore": [
            "*",
            "!package.json",
            "!bun.lock",
            "!apps/*/package.json",
            "!packages/akter",
            "!infra/local/runner",
            "**/node_modules",
          ].join("\n"),
          "docs/guide.md": "docs",
        })

        yield* fs.makeDirectory(`${root}/node_modules`)
        yield* fs.symlink(`${root}/missing-target`, `${root}/node_modules/dangling`)

        const packed = yield* packContext({
          context: `${root}/`,
          dockerfile: "infra/local/runner/Dockerfile",
        })
        const files = yield* unpack(packed.archive)

        expect(Object.keys(files)).toEqual([
          "apps/api/package.json",
          "bun.lock",
          "infra/local/runner/Dockerfile",
          "infra/local/runner/Dockerfile.dockerignore",
          "infra/local/runner/main.ts",
          "package.json",
          "packages/akter/src/index.ts",
        ])
        expect(packed.files.toSorted()).toEqual(Object.keys(files))
        expect(files["apps/api/package.json"]).toBe('{"name":"api"}')
        expect(files["infra/local/runner/main.ts"]).toBe("runner")
      }),
  )

  it.effect(
    "falls back to the root .dockerignore, always sends the Dockerfile, and refuses a context without one",
    () =>
      Effect.gen(function* () {
        const root = yield* context({
          ".dockerignore": "Dockerfile\n*.md\n",
          Dockerfile: "FROM scratch\n",
          "notes.md": "left out",
          "src/app.ts": "app",
        })
        const packed = yield* packContext({ context: root, dockerfile: "Dockerfile" })

        expect(Object.keys(yield* unpack(packed.archive))).toEqual([
          ".dockerignore",
          "Dockerfile",
          "src/app.ts",
        ])

        const refused = yield* Effect.flip(
          packContext({ context: root, dockerfile: "deploy/Dockerfile" }),
        )

        expect(refused).toEqual(
          ContextInvalid.make({ message: `No Dockerfile at ${root}/deploy/Dockerfile` }),
        )
      }),
  )
})
