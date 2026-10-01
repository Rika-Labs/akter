import { BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, ManagedRuntime, Path, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { generate } from "./generate.ts"

const USAGE =
  "usage: bun src/main.ts <openapi.json path or http(s) URL> --out <directory> [--name <python package>]"

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const RUNTIME = new URL("../python/runtime.py", import.meta.url)

/**
 * Writes the Python client of a served OpenAPI document under `--out`, as a
 * package named `--name` (default `durable_client`).
 */
export const main = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const client = yield* HttpClient.HttpClient
  const source = args[0]
  const out = args[args.indexOf("--out") + 1]
  const named = args.indexOf("--name")

  if (source === undefined || args.indexOf("--out") < 0 || out === undefined)
    return yield* Effect.die(new Error(USAGE))

  const text = /^https?:\/\//.test(source)
    ? yield* client.get(source).pipe(Effect.flatMap((response) => response.text))
    : yield* fs.readFileString(source)

  const files = yield* generate({
    document: yield* decodeJson(text),
    name: named < 0 ? "durable_client" : (args[named + 1] ?? ""),
    runtime: yield* fs.readFileString(RUNTIME.pathname),
  })

  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(out, file)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, contents)
  }

  yield* Console.log(`Wrote ${Object.keys(files).length} files under ${out}`)
})

if (import.meta.main) {
  const runtime = ManagedRuntime.make(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))
  await runtime.runPromise(main(Bun.argv.slice(2))).finally(() => runtime.dispose())
}
