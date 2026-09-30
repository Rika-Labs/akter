import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { conformanceGroups, type ConformanceGroup } from "../../conformance.ts"
import { nekiExcluded } from "./groups.ts"

const harness = ManagedRuntime.make(BunFileSystem.layer)

afterAll(() => harness.dispose())

/** A group's cases live in the module its name gives, beside the Neki folder, except for these. */
const modules: Partial<Record<ConformanceGroup, string>> = {
  foundation: "../foundation.ts",
  counter: "../conformance.ts",
  reducer: "reducers.ts",
  edge: "assertions.ts",
  coldServeEdge: "cold-serve.ts",
  content: "content-blobs.ts",
}

const moduleOf = (group: ConformanceGroup) =>
  modules[group] ??
  `${group
    .replace(/(Cluster|Retention|Delivery)$/, "")
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.ts`

/**
 * Whether a group's module, a `-harness` module it imports, or a module in the
 * folder of the same name beside it opens a fresh database or a snapshot; a
 * shared harness or a themed slice of the group can hold the call.
 */
const needsFreshDatabase = Effect.fnUntraced(function* (group: ConformanceGroup) {
  const fs = yield* FileSystem.FileSystem
  const file = new URL(`../${moduleOf(group)}`, import.meta.url)
  const source = yield* fs.readFileString(file.pathname)

  const beside = Array.from(
    source.matchAll(/from "(\.\/[\w-]+-harness\.ts)"/g),
    ([, name]) => name!,
  )

  const folder = new URL(moduleOf(group).replace(/\.ts$/, "/"), new URL("../", import.meta.url))

  const sliced =
    !moduleOf(group).includes("/") && (yield* fs.exists(folder.pathname))
      ? (yield* fs.readDirectory(folder.pathname))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => `./${moduleOf(group).replace(/\.ts$/, "")}/${name}`)
      : []

  const sources = yield* Effect.forEach([...beside, ...sliced], (name) =>
    fs.readFileString(new URL(name, file).pathname),
  )

  return [source, ...sources].some((text) => /environment\.(freshDatabase|snapshot)/.test(text))
})

describe("Neki conformance groups", () => {
  it("excludes only groups that exist, once each", () => {
    expect(new Set(nekiExcluded).size).toBe(nekiExcluded.length)
    expect(nekiExcluded.filter((group) => !(group in conformanceGroups))).toEqual([])
  })

  it("excludes every group whose module opens a fresh database or a snapshot", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const excluded = new Set<string>(nekiExcluded)

        const running = yield* Effect.filter(
          (Object.keys(conformanceGroups) as Array<ConformanceGroup>).filter(
            (group) => !excluded.has(group),
          ),
          needsFreshDatabase,
        )

        expect(running).toEqual([])
      }),
    ))

  it("excludes only groups whose module opens a fresh database or a snapshot", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const left = yield* Effect.filter(nekiExcluded, (group) =>
          Effect.map(needsFreshDatabase(group), (opens) => !opens),
        )

        expect(left).toEqual([])
      }),
    ))
})
