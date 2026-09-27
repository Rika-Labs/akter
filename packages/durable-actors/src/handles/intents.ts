import { Context, DateTime, Duration, Effect, Schema } from "effect"
import {
  type ActorRef,
  type Caller,
  type MintProof,
  type Principal,
  System,
} from "../identity/caller.ts"

/** When a staged intent becomes due: relative to the turn's commit, or at an instant. */
export const Due = Schema.TaggedUnion({
  After: { millis: Schema.Int },
  At: { epochMillis: Schema.Int },
})

export type Due = typeof Due.Type

export interface IntentOptions {
  readonly due?: Due
  readonly key?: string
}

export interface StagedIntent {
  readonly target: ActorRef
  readonly command: string
  readonly payload: string
  readonly caller: Caller
  readonly due: Due | undefined
  readonly key: string | undefined
}

/** An effect a turn performed: its tag, encoded instance, and the caller its routes see. */
export interface StagedEffect {
  readonly effect: string
  readonly payload: string
  readonly caller: Caller
}

/**
 * Everything one turn asked the outbox to do. `replaced` lists keys whose
 * committed rows the turn deletes before inserting `intents`.
 */
export interface StagedOutbox {
  readonly intents: ReadonlyArray<StagedIntent>
  readonly replaced: ReadonlyArray<string>
  readonly effects: ReadonlyArray<StagedEffect>
}

export const emptyOutbox: StagedOutbox = { intents: [], replaced: [], effects: [] }

/**
 * Marks a command turn. Only the runtime provides it, and `X.toLayer` removes
 * it from handler requirements, so `X.intents` and `Intent.cancel` outside a
 * command turn leave an unsatisfiable requirement.
 */
export class InTurn extends Context.Service<InTurn, { readonly turn: symbol }>()(
  "@durable-actors/core/handles/intents/InTurn",
) {}

interface Minted {
  readonly child: ActorRef
  readonly createdBy: string
  readonly proof: MintProof
}

interface Staging {
  readonly sender: ActorRef
  readonly onBehalfOf: Principal | undefined
  readonly minted: Map<string, Minted>
  open: boolean
  intents: Array<StagedIntent>
  readonly replaced: Set<string>
  readonly effects: Array<StagedEffect>
}

// Keyed by the provided marker, so a hand-built `InTurn` value stages nothing.
const stagings = new WeakMap<InTurn["Service"], Staging>()

const mintKey = (ref: ActorRef) => JSON.stringify([ref.actor, ref.id])

const isSystem = Schema.is(System)

const creates = (intent: StagedIntent, child: ActorRef, createdBy: string) =>
  intent.command === createdBy &&
  intent.target.actor === child.actor &&
  intent.target.id === child.id

/** Opens the outbox of one command turn; `close` returns what it staged and seals it. */
export const openOutbox = ({
  sender,
  onBehalfOf,
  commandId,
}: {
  readonly sender: ActorRef
  readonly onBehalfOf: Principal | undefined
  readonly commandId: string
}) => {
  const marker = InTurn.of({ turn: Symbol() })

  const staging: Staging = {
    sender,
    onBehalfOf,
    minted: new Map(),
    open: true,
    intents: [],
    replaced: new Set(),
    effects: [],
  }

  stagings.set(marker, staging)

  return {
    marker,
    /** Stages an effect; the caller checks that its turn is still running. */
    perform: (effect: Pick<StagedEffect, "effect" | "payload">) => {
      // Routes deliver to the performing actor as the effect, on the turn's principal.
      staging.effects.push({
        ...effect,
        caller: System.make({ source: "effect", ref: sender, onBehalfOf }),
      })
    },
    /** The proof the next `turn.mint` call of this turn carries. */
    nextMint: (): MintProof => ({ commandId, ordinal: staging.minted.size }),
    /** Records a minted id; its creating intent then carries `proof`. */
    minted: (child: ActorRef, createdBy: string, proof: MintProof) => {
      staging.minted.set(mintKey(child), { child, createdBy, proof })

      staging.intents = staging.intents.map((intent) =>
        creates(intent, child, createdBy) && isSystem(intent.caller)
          ? {
              ...intent,
              caller: System.make({
                source: intent.caller.source,
                ref: intent.caller.ref,
                onBehalfOf: intent.caller.onBehalfOf,
                mint: proof,
              }),
            }
          : intent,
      )
    },
    /** A minted actor that no staged intent to its creating command targets, if any. */
    uncreated: (): ActorRef | undefined => {
      for (const { child, createdBy, proof } of staging.minted.values())
        if (
          !staging.intents.some(
            (intent) =>
              creates(intent, child, createdBy) &&
              isSystem(intent.caller) &&
              intent.caller.mint?.commandId === proof.commandId &&
              intent.caller.mint.ordinal === proof.ordinal,
          )
        )
          return child

      return undefined
    },
    close: (): StagedOutbox => {
      staging.open = false

      return { intents: staging.intents, replaced: [...staging.replaced], effects: staging.effects }
    },
  }
}

const IntentSettings = Context.Reference<IntentOptions>("durable-actors/IntentSettings", {
  defaultValue: () => ({}),
})

const replaceKey = (staging: Staging, key: string) => {
  staging.intents = staging.intents.filter((intent) => intent.key !== key)
  staging.replaced.add(key)
}

/** The staging area of the turn `marker` belongs to, if that turn is still running. */
export const currentStaging = Effect.fnUntraced(function* (marker?: InTurn["Service"]) {
  const current = yield* InTurn
  const staging = stagings.get(current)

  if (staging === undefined || !staging.open || (marker !== undefined && marker !== current))
    return yield* Effect.die(new Error("Intent capability escaped its turn"))

  return { marker: current, staging }
})

export const stage = Effect.fnUntraced(function* (
  marker: InTurn["Service"],
  intent: Pick<StagedIntent, "target" | "command" | "payload">,
) {
  const { staging } = yield* currentStaging(marker)
  const { due, key } = yield* IntentSettings

  const minted = staging.minted.get(mintKey(intent.target))

  // The receiver sees the sending actor, attributed to the sending turn's principal.
  const attribution = {
    source: due === undefined ? ("actor" as const) : ("timer" as const),
    ref: staging.sender,
    onBehalfOf: staging.onBehalfOf,
  }

  // Only a minted child's creating intent carries the proof that lets it create the child.
  const caller =
    minted?.createdBy === intent.command
      ? System.make({ ...attribution, mint: minted.proof })
      : System.make(attribution)

  if (key !== undefined) replaceKey(staging, key)
  staging.intents.push({ ...intent, due, key, caller })
})

const configure =
  (options: IntentOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const outer = yield* IntentSettings

      return yield* Effect.provideService(self, IntentSettings, { ...options, ...outer })
    })

/**
 * Options for intents staged by the piped Effect. The outermost setting wins,
 * so a later `pipe` step overrides an earlier one.
 */
export const Intent = {
  /** Delivers no earlier than `duration` after the turn commits. */
  after: (duration: Duration.Input) => {
    const millis = Duration.toMillis(duration)

    if (!Number.isFinite(millis) || millis < 0)
      throw new Error("Intent.after needs a finite, non-negative duration")

    return configure({ due: Due.cases.After.make({ millis: Math.ceil(millis) }) })
  },
  /** Delivers no earlier than `instant`, measured on the database clock. */
  at: (instant: DateTime.DateTime) =>
    configure({ due: Due.cases.At.make({ epochMillis: DateTime.toEpochMillis(instant) }) }),
  /**
   * Names the intent within its sending actor. Staging another intent with the
   * same key, in this turn or a later one, replaces it while it is pending.
   */
  key: (key: string) => {
    if (key.length === 0 || key.length > 200) throw new Error("Intent.key must be 1-200 characters")

    return configure({ key })
  },
  /** Removes the sending actor's pending intent with `key` when this turn commits. */
  cancel: (key: string): Effect.Effect<void, never, InTurn> =>
    Effect.gen(function* () {
      const { staging } = yield* currentStaging()
      replaceKey(staging, key)
    }),
}
