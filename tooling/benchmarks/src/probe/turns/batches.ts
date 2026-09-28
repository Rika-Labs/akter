import { Actor } from "@durable-actors/core"
import { Deferred, Effect, Schema } from "effect"

/** Holds its turn open until the scenario releases the gate named by its input. */
export const Hold = Actor.command("Hold", { input: Schema.String, output: Schema.Int })

export const Add = Actor.command("Add", { input: Schema.Int, output: Schema.Int })

/** One actor whose next turn the scenario can hold, so commands queue behind it. */
export const BatchProbe = Actor.make("BatchProbe", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Hold, Add },
})

interface Gate {
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}

const gates = new Map<string, Gate>()

interface Arrivals {
  count: number
  readonly target: number
  readonly done: Deferred.Deferred<void>
}

const arrivals = new Map<string, Arrivals>()

/** A gate the next `Hold` with this name waits on. */
export const gate = (name: string) => {
  const opened: Gate = { started: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() }
  gates.set(name, opened)

  return opened
}

/** Resolves once `target` more commands are in the actor's mailbox. */
export const expectArrivals = ({
  actorId,
  target,
}: {
  readonly actorId: string
  readonly target: number
}) => {
  const done = Deferred.makeUnsafe<void>()
  arrivals.set(actorId, { count: 0, target, done })

  return Deferred.await(done)
}

/** The runtime's `queued` point: counts commands entering a `BatchProbe` mailbox. */
export const queued = ({
  ref,
}: {
  readonly ref: { readonly actor: string; readonly id: string }
}) =>
  Effect.sync(() => {
    if (ref.actor !== BatchProbe.name) return

    const waiting = arrivals.get(ref.id)

    if (waiting === undefined) return

    waiting.count += 1

    if (waiting.count === waiting.target) {
      arrivals.delete(ref.id)
      Deferred.doneUnsafe(waiting.done, Effect.void)
    }
  })

export const BatchProbeLive = BatchProbe.toLayer(
  Effect.succeed({
    Hold: Effect.fnUntraced(function* (name: string) {
      const held = gates.get(name)

      if (held !== undefined) {
        gates.delete(name)
        yield* Deferred.succeed(held.started, undefined)
        yield* Deferred.await(held.release)
      }

      const turn = yield* BatchProbe.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })

      return turn.state.count
    }),
    Add: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* BatchProbe.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
  }),
)
