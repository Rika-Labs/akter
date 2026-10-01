import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { classes, styles, themeClass } from "@akter/ui"

const runtime = ManagedRuntime.make(BunServices.layer)

describe("compiled StyleX UI", () => {
  it("emits CSS classes backed by actual compiled rules", () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        const css = yield* fs.readFileString(
          new URL("../dist/styles.css", import.meta.url).pathname,
        )

        for (const name of classes(styles.button).split(" ")) expect(css).toContain(`.${name}`)
        expect(css).toContain("@layer")
        expect(css).toContain("#f7f8fa")
        expect(css).toContain("#101819")
        expect(themeClass("dark")).not.toBe(themeClass("light"))
      }),
    ))
})
