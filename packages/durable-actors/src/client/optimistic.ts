import { Data, Effect, Exit, Option, Result, Schema } from "effect"
import type { OptimisticReducer, StateValue } from "../actor/served.ts"

/** A reducer input applied ahead of its receipt. */
export interface PendingInput {
  readonly member: string
  readonly input: unknown
}

interface Entry extends PendingInput {
  readonly reducer: OptimisticReducer
}

class Rejected extends Data.TaggedError("Rejected") {}

type Copy = (state: StateValue) => Effect.Effect<StateValue, Schema.SchemaError>

const copiers = new WeakMap<OptimisticReducer, Copy>()

/** Round-trips state through its JSON codec: a private copy, and a check that it fits the schema. */
const copierOf = (reducer: OptimisticReducer): Copy => {
  const existing = copiers.get(reducer)

  if (existing !== undefined) return existing

  const json = Schema.toCodecJson(reducer.state)
  const encode = Schema.encodeEffect(json)
  const decode = Schema.decodeEffect(json)

  const copy: Copy = (state) =>
    encode(state).pipe(
      Effect.map((encoded) => structuredClone(encoded)),
      Effect.flatMap(decode),
    )

  copiers.set(reducer, copy)

  return copy
}

/** `entry`'s reducer over a copy of `state`; none when it fails, throws, or returns an invalid state. */
const apply = (entry: Entry, state: StateValue): Option.Option<StateValue> => {
  const copy = copierOf(entry.reducer)

  const exit = Effect.runSyncExit(
    Effect.gen(function* () {
      const given = yield* copy(state)

      const reduced = yield* Effect.try({
        try: () => entry.reducer.reduce(given, entry.input),
        catch: () => new Rejected(),
      })

      if (Result.isFailure(reduced)) return yield* new Rejected()

      return yield* copy(reduced.success)
    }),
  )

  return Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none()
}

const applyOrKeep = (state: StateValue, entry: Entry) =>
  Option.getOrElse(apply(entry, state), () => state)

/** A private copy of `state`, or `state` itself when it does not fit the schema. */
const own = (reducer: OptimisticReducer | undefined, state: StateValue): StateValue => {
  if (reducer === undefined) return state

  const exit = Effect.runSyncExit(copierOf(reducer)(state))

  return Exit.isSuccess(exit) ? exit.value : state
}

/**
 * One actor's state as a client sees it: the committed state it last learned
 * and the reducer inputs still waiting for receipts, applied in call order.
 */
export class Optimistic {
  private committed: Option.Option<StateValue> = Option.none()
  private entries: ReadonlyArray<Entry> = []
  private view: StateValue | undefined = undefined
  private readonly listeners = new Set<(state: StateValue | undefined) => void>()
  /** Settles when the last reducer call queued here has; reducer calls send one at a time. */
  queue: Promise<void> = Promise.resolve()

  /** `reducer` is any of the actor's reducers; its state schema copies what goes in and out. */
  constructor(private readonly reducer: OptimisticReducer | undefined) {}

  get state(): StateValue | undefined {
    return this.view
  }

  get pending(): ReadonlyArray<PendingInput> {
    return this.entries.map(({ member, input }) => ({ member, input: structuredClone(input) }))
  }

  /** Nothing pending and nobody listening, so dropping it loses nothing. */
  get isIdle(): boolean {
    return this.entries.length === 0 && this.listeners.size === 0
  }

  subscribe(listener: (state: StateValue | undefined) => void): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  reconcile(committed: StateValue): void {
    this.committed = Option.some(own(this.reducer, committed))
    this.publish()
  }

  add(entry: Entry): void {
    this.entries = [...this.entries, entry]
    this.publish()
  }

  /**
   * Its receipt succeeded. A reducer's reply is the committed state; a
   * commutative reducer replies nothing, so it is applied to committed state here.
   */
  confirm(entry: Entry, reply: StateValue | undefined): void {
    this.entries = this.entries.filter((pending) => pending !== entry)
    this.committed =
      reply !== undefined
        ? Option.some(own(this.reducer, reply))
        : Option.map(this.committed, (committed) => applyOrKeep(committed, entry))
    this.publish()
  }

  /** Its call failed, so the input comes out of the view. */
  drop(entry: Entry): void {
    this.entries = this.entries.filter((pending) => pending !== entry)
    this.publish()
  }

  private publish(): void {
    this.view = Option.getOrUndefined(
      Option.map(this.committed, (committed) =>
        own(this.reducer, this.entries.reduce(applyOrKeep, committed)),
      ),
    )

    // A throwing listener goes to `reportError`, as a DOM event listener's would; the rest still run.
    for (const listener of this.listeners)
      try {
        listener(this.view)
      } catch (error) {
        reportError(error)
      }
  }
}
