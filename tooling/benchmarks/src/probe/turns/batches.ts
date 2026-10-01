import { Actor } from "@rikalabs/akter"
import { Deferred, Effect, Result, Schema } from "effect"

/** Holds its turn open until the scenario releases the gate named by its input. */
export const Hold = Actor.command("Hold", { payload: Schema.String, success: Schema.Int })

/** Adds the amount to the count and replies with the new total. */
export const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })

const state = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

/** A commutative reducer: calls already waiting merge into one turn. */
export const Tick = Actor.reducer("Tick", {
  state,
  payload: Schema.Int,
  reduce: (current, amount) => Result.succeed({ count: current.count + amount }),
  batch: { combine: (first, second) => first + second },
})

/** One actor whose next turn the scenario can hold, so commands queue behind it. */
export const BatchProbe = Actor.make("BatchProbe", {
  key: Schema.NonEmptyString,
  state,
  api: { Hold, Add, Tick },
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

/**
 * The runtime's `queued` point: counts commands entering a `BatchProbe`
 * mailbox.
 *
 * The command joins a batch only once this hook has returned, so the round
 * goes on in a later task.
 */
export const queued = ({
  ref,
}: {
  readonly ref: { readonly actor: string; readonly id: string }
}) =>
  Effect.suspend(() => {
    if (ref.actor !== BatchProbe.name) return Effect.void

    const waiting = arrivals.get(ref.id)

    if (waiting === undefined) return Effect.void

    waiting.count += 1

    if (waiting.count !== waiting.target) return Effect.void

    arrivals.delete(ref.id)

    return Effect.sleep(0).pipe(
      Effect.andThen(Deferred.succeed(waiting.done, undefined)),
      Effect.forkDetach,
      Effect.asVoid,
    )
  })

/** Handlers for `BatchProbe`. */
export const BatchProbeLive = BatchProbe.toLayer({
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
})
