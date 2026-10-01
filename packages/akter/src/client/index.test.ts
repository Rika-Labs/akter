import { Effect } from "effect"
import { describe, expect, it } from "vitest"

const FORBIDDEN =
  /\/(runtime|sql|tables|serve|testing)\/|^(bun|node:|pg$|@effect\/platform-|@effect\/sql|drizzle|@electric-sql)/

/**
 * Packages a browser declaration must never load: SQL, Cluster and serving
 * machinery, database drivers, and server platforms. Inert runtime tags and
 * protocol constants stay allowed, so this judges packages, not folders.
 */
const SERVER_PACKAGE =
  /^(bun$|bun:|node:|pg$|@electric-sql\/|@effect\/(sql|platform)-|effect\/(sql|cluster|http|http-api|rpc|process|socket)(\/|$)|drizzle-orm\/(effect-postgres|node-postgres|pglite|postgres-js|bun-sql)(\/|$))/

const declaration = `import { Actor } from "../../src/index.ts"
import { Schema } from "effect"

export const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })

export const Counter = Actor.make("BrowserCounter", { key: Schema.String, api: { Increment } })
`

const graph = Effect.fnUntraced(function* (entry: string) {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const seen = new Set<string>()
  const packages = new Set<string>()
  const pending = [entry]

  while (pending.length > 0) {
    const file = pending.pop()

    if (file === undefined || seen.has(file)) continue

    seen.add(file)
    const source = yield* Effect.promise(() => Bun.file(file).text())

    for (const { path } of transpiler.scanImports(source)) {
      if (path.startsWith(".")) pending.push(new URL(path, `file://${file}`).pathname)
      else packages.add(path)
    }
  }

  return { files: [...seen], packages: [...packages] }
})

describe("@rikalabs/akter/client", () => {
  it("imports no runtime, serving, SQL, or Cluster module in a browser build", () =>
    Effect.runPromise(
      Effect.forEach(
        [
          new URL("./index.ts", import.meta.url).pathname,
          new URL("./make.ts", import.meta.url).pathname,
        ],
        (entry) =>
          Effect.gen(function* () {
            const { files, packages } = yield* graph(entry)

            expect(files.filter((file) => FORBIDDEN.test(file))).toEqual([])

            expect(
              packages.filter((name) => FORBIDDEN.test(name) || name.includes("cluster")),
            ).toEqual([])

            const build = yield* Effect.promise(() =>
              Bun.build({ entrypoints: [entry], target: "browser" }),
            )

            expect(build.success).toBe(true)
          }),
      ),
    ))
})

describe("@rikalabs/akter in a browser", () => {
  it("builds the root entry and an actor declaration without server packages", () =>
    Effect.gen(function* () {
      const counter = new URL("../../.cache/browser/counter.ts", import.meta.url).pathname

      yield* Effect.promise(() => Bun.write(counter, declaration))

      for (const entry of [new URL("../index.ts", import.meta.url).pathname, counter]) {
        const { packages } = yield* graph(entry)

        expect(packages.filter((name) => SERVER_PACKAGE.test(name))).toEqual([])

        const build = yield* Effect.promise(() =>
          Bun.build({ entrypoints: [entry], target: "browser", minify: true }),
        )

        expect(build.success).toBe(true)
      }
    }).pipe(Effect.runPromise))
})
