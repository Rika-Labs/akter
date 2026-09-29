import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import { conformanceGroups, type ConformanceGroup } from "../../conformance.ts"
import { nekiGroups } from "./groups.ts"

const harness = ManagedRuntime.make(BunFileSystem.layer)

afterAll(() => harness.dispose())

// A group's cases live in the module its name gives, beside the Neki folder, except for these.
const modules: Partial<Record<ConformanceGroup, string>> = {
  foundation: "../foundation.ts",
  counter: "../conformance.ts",
  reducer: "reducers.ts",
  edge: "assertions.ts",
  content: "content-blobs.ts",
}

const moduleOf = (group: ConformanceGroup) =>
  modules[group] ??
  `${group
    .replace(/(Cluster|Retention|Delivery)$/, "")
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.ts`

const needsFreshDatabase = Effect.fnUntraced(function* (group: ConformanceGroup) {
  const fs = yield* FileSystem.FileSystem

  const source = yield* fs.readFileString(
    new URL(`../${moduleOf(group)}`, import.meta.url).pathname,
  )

  return /environment\.(freshDatabase|snapshot)/.test(source)
})

describe("Neki conformance groups", () => {
  it("runs only groups that exist, once each", () => {
    expect(new Set(nekiGroups).size).toBe(nekiGroups.length)
    expect(nekiGroups.filter((group) => !(group in conformanceGroups))).toEqual([])
  })

  it("runs no group whose module opens a fresh database or a snapshot", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const opening = yield* Effect.filter(nekiGroups, needsFreshDatabase)

        expect(opening).toEqual([])
      }),
    ))

  it("leaves out only groups whose module opens a fresh database or a snapshot", () =>
    harness.runPromise(
      Effect.gen(function* () {
        const running = new Set<string>(nekiGroups)

        const left = yield* Effect.filter(
          (Object.keys(conformanceGroups) as Array<ConformanceGroup>).filter(
            (group) => !running.has(group),
          ),
          (group) => Effect.map(needsFreshDatabase(group), (opens) => !opens),
        )

        expect(left).toEqual([])
      }),
    ))
})
