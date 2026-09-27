import { Effect } from "effect"
import { describe, expect, it } from "vitest"

const FORBIDDEN =
  /\/(runtime|sql|tables|serve|testing)\/|^(bun|node:|pg$|@effect\/platform-|@effect\/sql|drizzle|@electric-sql)/

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

describe("durable-actors/client", () => {
  it("imports no runtime, SQL, or Cluster module in a browser build", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entry = new URL("./index.ts", import.meta.url).pathname
        const { files, packages } = yield* graph(entry)

        expect(files.some((file) => file.endsWith("/errors/actor.ts"))).toBe(true)
        expect(files.filter((file) => FORBIDDEN.test(file))).toEqual([])

        expect(packages.filter((name) => FORBIDDEN.test(name) || name.includes("cluster"))).toEqual(
          [],
        )

        const build = yield* Effect.promise(() =>
          Bun.build({ entrypoints: [entry], target: "browser" }),
        )

        expect(build.success).toBe(true)
      }),
    ))
})
