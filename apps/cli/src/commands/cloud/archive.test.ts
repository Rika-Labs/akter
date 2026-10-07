import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ignoreRules, isIgnored, packContext } from "./archive.ts"

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
  it("matches ignore patterns as Git does: unanchored names at every depth, anchored paths, globstars, directory-only rules, pruned directories and the last matching rule", () => {
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
        "tmp/",
        "vendor",
        "!vendor/kept.ts",
      ].join("\n"),
    )
    const ignored = isIgnored(rules)

    expect(ignored("node_modules", true)).toBe(true)
    expect(ignored("node_modules/pkg/index.js", false)).toBe(true)
    expect(ignored("apps/web/node_modules/pkg/index.js", false)).toBe(true)
    expect(ignored("apps/web/node_modules_cache/index.js", false)).toBe(false)
    expect(ignored("secret.env", false)).toBe(true)
    expect(ignored("config/secret.env", false)).toBe(false)
    expect(ignored("error.log", false)).toBe(true)
    expect(ignored("keep.log", false)).toBe(false)
    expect(ignored("logs/error.log", false)).toBe(true)
    expect(ignored("logs/keep.log", false)).toBe(false)
    expect(ignored("docs/draft.md", false)).toBe(true)
    expect(ignored("docs/a/b/draft.md", false)).toBe(true)
    expect(ignored("docs/final.md", false)).toBe(false)
    expect(ignored("build1/out.js", false)).toBe(true)
    expect(ignored("build12/out.js", false)).toBe(false)
    expect(ignored("tmp/scratch", false)).toBe(true)
    expect(ignored("src/tmp/scratch", false)).toBe(true)
    expect(ignored("src/tmp", false)).toBe(false)
    expect(ignored("vendor/kept.ts", false)).toBe(true)
    expect(ignored("README.md", false)).toBe(false)
    expect(isIgnored(ignoreRules("a.b"))("a.b", false)).toBe(true)
    expect(isIgnored(ignoreRules("a.b"))("aXb", false)).toBe(false)
  })

  it.effect(
    "packs what .akterignore keeps over .gitignore, never descending into a directory it leaves out, and always leaves out .git",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* context({
          "package.json": "{}",
          "bun.lock": "lock",
          ".gitignore": "README.md\n",
          "README.md": "left out by .gitignore, kept by .akterignore",
          ".akterignore": [
            "*",
            "!*/",
            "!package.json",
            "!bun.lock",
            "!README.md",
            "!src/**",
            "**/node_modules",
            "!.akterignore",
          ].join("\n"),
          "src/app.ts": "export default app",
          "src/actors/counter.ts": "counter",
          "src/node_modules/dep/index.js": "dependency",
          "docs/guide.md": "docs",
          ".git/HEAD": "ref: refs/heads/main",
        })

        yield* fs.makeDirectory(`${root}/node_modules`)
        yield* fs.symlink(`${root}/missing-target`, `${root}/node_modules/dangling`)

        const packed = yield* packContext({ context: `${root}/` })
        const files = yield* unpack(packed.archive)

        expect(Object.keys(files)).toEqual([
          ".akterignore",
          "README.md",
          "bun.lock",
          "package.json",
          "src/actors/counter.ts",
          "src/app.ts",
        ])
        expect(packed.files.toSorted()).toEqual(Object.keys(files))
        expect(files["src/app.ts"]).toBe("export default app")
      }),
  )

  it.effect(
    "falls back to .gitignore, packs every file without an ignore file but .git, and needs no Dockerfile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const ignoring = yield* context({
          ".gitignore": "*.md\n.env\n",
          ".env": "SECRET=1",
          "notes.md": "left out",
          "src/app.ts": "app",
          "src/.env": "SECRET=2",
        })
        const plain = yield* context({ "src/app.ts": "app", "notes.md": "kept", ".git/HEAD": "x" })

        expect(
          Object.keys(yield* unpack((yield* packContext({ context: ignoring })).archive)),
        ).toEqual([".gitignore", "src/app.ts"])
        expect(
          Object.keys(yield* unpack((yield* packContext({ context: plain })).archive)),
        ).toEqual(["notes.md", "src/app.ts"])
        expect(yield* fs.exists(`${plain}/.git/HEAD`)).toBe(true)
      }),
  )

  it.effect(
    "sends symbolic links as links without reading what they point at, so neither a secret outside the context nor a loop is followed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const outside = yield* fs.makeTempDirectoryScoped()
        const root = yield* context({
          "src/app.ts": "app",
          "app/run.sh": "#!/bin/sh\necho run\n",
        })

        yield* fs.writeFileString(`${outside}/id_ed25519`, "PRIVATE KEY MATERIAL")
        yield* fs.symlink(`${outside}/id_ed25519`, `${root}/deploy-key`)
        yield* fs.symlink(".", `${root}/app/loop`)
        yield* fs.symlink("run.sh", `${root}/app/start.sh`)
        yield* fs.chmod(`${root}/app/run.sh`, 0o755)

        const packed = yield* packContext({ context: root })
        const listing = yield* systemTar(packed.archive, ["-tvzf", "-"])
        const extracted = yield* fs.makeTempDirectoryScoped()

        expect(listing.code).toBe(0)
        expect(packed.files).toEqual([
          "app/loop",
          "app/run.sh",
          "app/start.sh",
          "deploy-key",
          "src/app.ts",
        ])
        expect(new TextDecoder().decode(Bun.gunzipSync(packed.archive))).not.toContain(
          "PRIVATE KEY MATERIAL",
        )
        expect((yield* systemTar(packed.archive, ["-xzf", "-", "-C", extracted])).code).toBe(0)
        expect(yield* fs.readLink(`${extracted}/deploy-key`)).toBe(`${outside}/id_ed25519`)
        expect(yield* fs.readLink(`${extracted}/app/loop`)).toBe(".")
        expect(yield* fs.readLink(`${extracted}/app/start.sh`)).toBe("run.sh")
        expect((yield* fs.stat(`${extracted}/app/run.sh`)).mode & 0o777).toBe(0o755)
        expect((yield* fs.stat(`${extracted}/src/app.ts`)).mode & 0o111).toBe(0)
      }),
  )

  it.effect(
    "packs a path longer than a tar name field so a standard tar reads it back whole, and packs the same files to the same bytes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const deep = `${"nested-directory-name/".repeat(6)}file-with-a-long-name-ünïcode.txt`
        const root = yield* context({ "src/app.ts": "app", [deep]: "deep contents" })
        const first = yield* packContext({ context: root })
        const second = yield* packContext({ context: root })
        const extracted = yield* fs.makeTempDirectoryScoped()

        expect(deep.length).toBeGreaterThan(100)
        expect(Array.from(second.archive)).toEqual(Array.from(first.archive))
        expect((yield* systemTar(first.archive, ["-xzf", "-", "-C", extracted])).code).toBe(0)
        expect(yield* fs.readFileString(`${extracted}/${deep}`)).toBe("deep contents")
      }),
  )
})
