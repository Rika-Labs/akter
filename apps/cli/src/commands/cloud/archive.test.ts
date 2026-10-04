import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ContextInvalid, contextPath, ignoreRules, isIgnored, packContext } from "./archive.ts"

/** Runs the system `tar` on `args` with `archive` on stdin, independently of the packer under test. */
const systemTar = (archive: Uint8Array, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make("tar", [...args], { stdin: Stream.make(archive) }),
    )
    const [out] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText, Stream.mkString), handle.stderr.pipe(Stream.runDrain)],
      { concurrency: 2 },
    )

    return { code: Number(yield* handle.exitCode), out }
  }).pipe(Effect.scoped, Effect.orDie)

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

  it("accepts a Dockerfile path inside the context, cleaned, and nothing that leaves it", () => {
    expect(contextPath("Dockerfile")).toEqual(Option.some("Dockerfile"))
    expect(contextPath("./infra//runner/./Dockerfile")).toEqual(
      Option.some("infra/runner/Dockerfile"),
    )
    for (const path of [
      "",
      ".",
      "/etc/Dockerfile",
      "../Dockerfile",
      "infra/../../Dockerfile",
      "a/..",
    ])
      expect(contextPath(path), path).toEqual(Option.none())
  })

  it.effect(
    "sends symbolic links as links without reading what they point at, so neither a secret outside the context nor a loop is followed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const outside = yield* fs.makeTempDirectoryScoped()
        const root = yield* context({
          Dockerfile: "FROM scratch\n",
          "app/run.sh": "#!/bin/sh\necho run\n",
        })

        yield* fs.writeFileString(`${outside}/id_ed25519`, "PRIVATE KEY MATERIAL")
        yield* fs.symlink(`${outside}/id_ed25519`, `${root}/deploy-key`)
        yield* fs.symlink(".", `${root}/app/loop`)
        yield* fs.symlink("run.sh", `${root}/app/start.sh`)
        yield* fs.chmod(`${root}/app/run.sh`, 0o755)

        const packed = yield* packContext({ context: root, dockerfile: "Dockerfile" })
        const listing = yield* systemTar(packed.archive, ["-tvzf", "-"])
        const extracted = yield* fs.makeTempDirectoryScoped()

        expect(listing.code).toBe(0)
        expect(packed.files).toEqual([
          "Dockerfile",
          "app/loop",
          "app/run.sh",
          "app/start.sh",
          "deploy-key",
        ])
        expect(new TextDecoder().decode(Bun.gunzipSync(packed.archive))).not.toContain(
          "PRIVATE KEY MATERIAL",
        )
        expect((yield* systemTar(packed.archive, ["-xzf", "-", "-C", extracted])).code).toBe(0)
        expect(yield* fs.readLink(`${extracted}/deploy-key`)).toBe(`${outside}/id_ed25519`)
        expect(yield* fs.readLink(`${extracted}/app/loop`)).toBe(".")
        expect(yield* fs.readLink(`${extracted}/app/start.sh`)).toBe("run.sh")
        expect((yield* fs.stat(`${extracted}/app/run.sh`)).mode & 0o777).toBe(0o755)
        expect((yield* fs.stat(`${extracted}/Dockerfile`)).mode & 0o111).toBe(0)
      }),
  )

  it.effect(
    "packs a path longer than a tar name field so a standard tar reads it back whole, and packs the same files to the same bytes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const deep = `${"nested-directory-name/".repeat(6)}file-with-a-long-name-ünïcode.txt`
        const root = yield* context({ Dockerfile: "FROM scratch\n", [deep]: "deep contents" })
        const first = yield* packContext({ context: root, dockerfile: "Dockerfile" })
        const second = yield* packContext({ context: root, dockerfile: "Dockerfile" })
        const extracted = yield* fs.makeTempDirectoryScoped()

        expect(deep.length).toBeGreaterThan(100)
        expect(Array.from(second.archive)).toEqual(Array.from(first.archive))
        expect((yield* systemTar(first.archive, ["-xzf", "-", "-C", extracted])).code).toBe(0)
        expect(yield* fs.readFileString(`${extracted}/${deep}`)).toBe("deep contents")
      }),
  )
})
