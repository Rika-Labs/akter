import { Actor, Intent } from "@durable-actors/core"
import { DateTime, Deferred, Effect, Layer, Schema } from "effect"

export const Open = Actor.command("Open", { input: Schema.String })

/** A child that only its parent's minting turn, or `create()`, brings into being. */
export const MintedChild = Actor.make("MintedChild", {
  api: { Open },
  policy: { createdBy: Open },
})

export const MintMany = Actor.command("MintMany", {
  input: Schema.Struct({
    label: Schema.String,
    count: Schema.Int,
    atMs: Schema.optional(Schema.Int),
  }),
})

/** Mints `count` children per turn and stages each one's creating intent. */
export const Minter = Actor.make("Minter", { key: Schema.NonEmptyString, api: { MintMany } })

/** Pending child creations by label, completed by the child's creating turn. */
export const creations = new Map<string, Deferred.Deferred<void>>()

export const MintLive = Layer.mergeAll(
  MintedChild.toLayer(
    Effect.succeed({
      Open: (label: string) =>
        Effect.suspend(() => {
          const pending = creations.get(label)

          return pending === undefined ? Effect.void : Deferred.succeed(pending, undefined)
        }).pipe(Effect.asVoid),
    }),
  ),
  Minter.toLayer(
    Effect.succeed({
      MintMany: Effect.fnUntraced(function* ({ label, count, atMs }) {
        const turn = yield* Minter.Turn

        for (let index = 0; index < count; index++) {
          const id = yield* turn.mint(MintedChild)
          const open = (yield* MintedChild.intents(id)).Open(`${label}-${index}`)
          yield* atMs === undefined ? open : open.pipe(Intent.at(DateTime.makeUnsafe(atMs)))
        }
      }),
    }),
  ),
)
