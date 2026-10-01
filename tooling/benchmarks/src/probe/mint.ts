import { Actor, Intent } from "@rikalabs/akter"
import { DateTime, Deferred, Effect, Layer, Schema } from "effect"

/** Creating command of `MintedChild`; completes the pending creation for the label. */
export const Open = Actor.command("Open", { payload: Schema.String })

/** A child that only its parent's minting turn, or `create()`, brings into being. */
export const MintedChild = Actor.make("MintedChild", {
  api: { Open },
  createdBy: Open,
})

/**
 * Mints `count` children, optionally staging each one's creating intent at
 * `atMs`, and replies with their ids.
 */
export const MintMany = Actor.command("MintMany", {
  payload: Schema.Struct({
    label: Schema.String,
    count: Schema.Int,
    atMs: Schema.optional(Schema.Int),
  }),
  success: Schema.Array(Schema.String),
})

/** Mints `count` children per turn and stages each one's creating intent. */
export const Minter = Actor.make("Minter", { key: Schema.NonEmptyString, api: { MintMany } })

/** Pending child creations by label, completed by the child's creating turn. */
export const creations = new Map<string, Deferred.Deferred<void>>()

/** Handlers for `Minter` and `MintedChild`. */
export const MintLive = Layer.mergeAll(
  MintedChild.toLayer({
    Open: (label: string) =>
      Effect.suspend(() => {
        const pending = creations.get(label)

        return pending === undefined ? Effect.void : Deferred.succeed(pending, undefined)
      }).pipe(Effect.asVoid),
  }),
  Minter.toLayer({
    MintMany: Effect.fnUntraced(function* ({ label, count, atMs }) {
      const turn = yield* Minter.Turn
      const ids: Array<string> = []

      for (let index = 0; index < count; index++) {
        const id = yield* turn.mint(MintedChild)
        const open = (yield* MintedChild.intents(id)).Open(`${label}-${index}`)
        yield* atMs === undefined ? open : open.pipe(Intent.at(DateTime.makeUnsafe(atMs)))
        ids.push(id)
      }

      return ids
    }),
  }),
)
