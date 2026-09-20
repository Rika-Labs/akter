import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, ManagedRuntime } from "effect"

const root = new URL("../", import.meta.url)

const runtime = ManagedRuntime.make(BunServices.layer)

await runtime.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(new URL("dist", root).pathname, { recursive: true })

    const result = yield* Effect.tryPromise(() =>
      Bun.build({
        entrypoints: [new URL("src/main.ts", root).pathname],
        outdir: new URL("dist", root).pathname,
        target: "bun",
        minify: true,
      }),
    )

    if (!result.success)
      return yield* Effect.die(result.logs.map((message) => message.message).join("\n"))
    yield* fs.copyFile(
      new URL("../../../packages/ui/dist/styles.css", import.meta.url).pathname,
      new URL("dist/styles.css", root).pathname,
    )
    yield* Effect.log("Built server-only web app; no client bundle.")
  }),
)
