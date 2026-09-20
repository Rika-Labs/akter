import { transformFileAsync } from "@babel/core"
import stylexPlugin, { type Rule } from "@stylexjs/babel-plugin"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime, Stream } from "effect"

const root = new URL("../", import.meta.url).pathname

const runtime = ManagedRuntime.make(BunServices.layer)

interface StylexMetadata {
  stylex?: Rule[]
}

const build = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(`${root}dist`, { recursive: true })
  const rules: Rule[] = []

  for (const file of ["tokens.stylex", "index"]) {
    const result = yield* Effect.tryPromise(() =>
      transformFileAsync(`${root}src/${file}.ts`, {
        cwd: root,
        babelrc: false,
        configFile: false,
        plugins: [
          ["@babel/plugin-transform-typescript", {}],
          [
            "@stylexjs/babel-plugin",
            {
              dev: false,
              runtimeInjection: false,
              unstable_moduleResolution: { type: "commonJS", rootDir: root },
            },
          ],
        ],
      }),
    )

    if (result === null || result.code === null || result.code === undefined || result.code === "")
      return yield* Effect.die(`Compilation failed: ${file}`)
    // SAFETY: This transform installs the pinned StyleX plugin, whose documented metadata.stylex value is Rule[]. Babel's generic metadata type omits plugin fields.
    rules.push(...((result.metadata as StylexMetadata).stylex ?? []))
    yield* fs.writeFileString(`${root}dist/${file}.js`, result.code)
  }

  const css = stylexPlugin.processStylexRules(rules, { useLayers: true })
  yield* fs.writeFileString(
    `${root}dist/styles.css`,
    `*{box-sizing:border-box}body{margin:0}h1,h2,h3,p{margin-top:0}h2{font-size:18px;letter-spacing:-.3px}button,input{font:inherit}a{color:inherit}form{margin:0}table{overflow-wrap:anywhere}\n${css}`,
  )
  yield* Effect.log(`StyleX compiled ${rules.length} rules.`)
})

await runtime.runPromise(
  Effect.gen(function* () {
    yield* build()

    if (process.argv.includes("--watch")) {
      const fs = yield* FileSystem.FileSystem
      yield* fs.watch(`${root}src`).pipe(
        Stream.filter((event) => event.path.endsWith(".ts")),
        Stream.runForEach(() => build()),
      )
    }
  }),
)
