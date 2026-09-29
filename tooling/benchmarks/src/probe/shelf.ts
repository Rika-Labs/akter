import { Actor, ContentRef } from "@durable-actors/core"
import { Effect, Layer, Option, Schema } from "effect"

/** Shared content a `Shelf` references. */
export const Files = Actor.content("files")

const Attaching = Schema.Struct({ name: Schema.String, ref: ContentRef })

export const Attach = Actor.command("Attach", { input: Attaching })

/** The referenced content's length, read off-turn. */
export const Size = Actor.query("Size", { input: Schema.String, output: Schema.Int })

/** An actor that references tenant content, for the content-blobs scenario. */
export const Shelf = Actor.make("Shelf", {
  key: Schema.String,
  placement: "actor",
  blobs: [Files],
  api: { Attach, Size },
})

export const ShelfLive = Layer.mergeAll(
  Shelf.toLayer(
    Effect.succeed({
      Attach: Effect.fnUntraced(function* ({ name, ref }: typeof Attaching.Type) {
        yield* (yield* Shelf.Turn).blob(Files).attach(name, ref).pipe(Effect.orDie)
      }),
    }),
  ),
  Shelf.toQueryLayer(
    Effect.succeed({
      Size: Effect.fnUntraced(function* (name: string) {
        const found = yield* (yield* Shelf.Read).blob(Files).get(name)

        return Option.match(found, { onNone: () => -1, onSome: (bytes) => bytes.byteLength })
      }),
    }),
  ),
)
