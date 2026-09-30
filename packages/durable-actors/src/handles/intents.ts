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

/** When a staged intent becomes due. */
export type Due = typeof Due.Type

interface IntentOptions {
  readonly due?: Due
  readonly key?: string
}

/** An intent a turn staged: the command to send `target`, its encoded input, and who it appears to come from. `key` names it for replacement or cancellation. */
interface StagedIntent {
  readonly target: ActorRef
  readonly command: string
  readonly payload: string
  readonly caller: Caller
  readonly due: Due | undefined
  readonly key: string | undefined
}

/** A job a turn enqueued: its tag, encoded instance, and the caller its routes see. */
interface StagedJob {
  readonly job: string
  readonly payload: string
  /** The payload version `payload` is encoded at. */
  readonly version: number
  readonly caller: Caller
  readonly due: Due | undefined
  readonly key: string | undefined
  /** Whether the job declares `concurrency.perActor`, so its claims follow `ready_at_ms`. */
  readonly capped: boolean
}

/**
 * A dynamic subscription change a turn staged: `subscribe` from a position,
 * or `remove`. The last change a turn stages for one source wins.
 */
export interface StagedSubscription {
  readonly subscription: string
  readonly source: ActorRef
  readonly op: "subscribe" | "remove"
  /** `"now"`, `"start"`, or an exclusive source cursor; unused by `remove`. */
  readonly from: string
  /** The declaration's event tags, which decide which of the source's commits wake the row. */
  readonly events: ReadonlyArray<string>
}

/**
 * Everything one turn asked the outbox to do. `replaced` lists keys whose
 * committed rows the turn deletes before inserting `intents`;
 * `cancelledJobs` lists job keys whose committed jobs it cancels before
 * inserting `jobs`.
 */
export interface StagedOutbox {
  readonly intents: ReadonlyArray<StagedIntent>
  readonly replaced: ReadonlyArray<string>
  readonly jobs: ReadonlyArray<StagedJob>
  readonly subscriptions: ReadonlyArray<StagedSubscription>
  readonly cancelledJobs: ReadonlyArray<string>
}

/** The outbox of a turn that staged nothing. */
export const emptyOutbox: StagedOutbox = {
  intents: [],
  replaced: [],
  jobs: [],
  subscriptions: [],
  cancelledJobs: [],
}

/** Job keys live in the actor's key namespace under this prefix, which intent keys may not use. */
export const JOB_KEY_PREFIX = "$job:"

const checkKey = (what: string, key: string) => {
  if (key.length === 0 || key.length > 200) throw new Error(`${what} must be 1-200 characters`)
}

/**
 * Outbox keys the framework writes: `$`-prefixed keys and JSON arrays whose
 * first element is `$`-prefixed. An application key of that shape could
 * replace or cancel a framework row of the same actor.
 */
const isFrameworkKey = (key: string) => key.startsWith("$") || key.startsWith('["$')

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
  readonly commandId: string
  /** The sender's event sequence before this turn's emits. */
  readonly head: string
  readonly onBehalfOf: Principal | undefined
  readonly minted: Map<string, Minted>
  open: boolean
  intents: Array<StagedIntent>
  readonly replaced: Set<string>
  jobs: Array<StagedJob>
  readonly subscriptions: Map<string, StagedSubscription>
  readonly cancelledJobs: Set<string>
}

/** Keyed by the provided marker, so a hand-built `InTurn` value stages nothing. */
const stagings = new WeakMap<InTurn["Service"], Staging>()

const mintKey = (ref: ActorRef) => JSON.stringify([ref.actor, ref.id])

const isSystem = Schema.is(System)

const creates = (intent: StagedIntent, child: ActorRef, createdBy: string) =>
  intent.command === createdBy &&
  intent.target.actor === child.actor &&
  intent.target.id === child.id

/**
 * Opens the outbox of one command turn; `close` returns what it staged and
 * seals it. A staged job's routes deliver to the enqueuing actor as the job,
 * on the turn's principal.
 */
export const openOutbox = ({
  sender,
  commandId,
  head,
  onBehalfOf,
}: {
  readonly sender: ActorRef
  readonly commandId: string
  readonly head: string
  readonly onBehalfOf: Principal | undefined
}) => {
  const marker = InTurn.of({ turn: Symbol() })

  const staging: Staging = {
    sender,
    commandId,
    head,
    onBehalfOf,
    minted: new Map(),
    open: true,
    intents: [],
    replaced: new Set(),
    jobs: [],
    subscriptions: new Map(),
    cancelledJobs: new Set(),
  }

  stagings.set(marker, staging)

  return {
    marker,
    /** Stages a job; the caller checks that its turn is still running. */
    enqueue: (job: Pick<StagedJob, "job" | "payload" | "version" | "due" | "key" | "capped">) => {
      if (job.key !== undefined) cancelJobKey(staging, job.key)
      staging.jobs.push({
        ...job,
        caller: System.make({ source: "job", ref: sender, onBehalfOf }),
      })
    },
    /** Stages the cancellation of the job with `key`; the caller checks the turn. */
    cancelJob: (key: string) => cancelJobKey(staging, key),
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
    /**
     * A minted actor whose creating intent has a key, if any: a later keyed
     * intent or cancel could remove it before delivery and leave the id uncreated.
     */
    keyedCreation: (): ActorRef | undefined => {
      for (const { child, createdBy } of staging.minted.values())
        if (
          staging.intents.some(
            (intent) => creates(intent, child, createdBy) && intent.key !== undefined,
          )
        )
          return child

      return undefined
    },
    /** Stages a subscription change; a later change for the same source replaces it. */
    subscribe: (change: StagedSubscription) => {
      staging.subscriptions.set(
        JSON.stringify([change.subscription, change.source.actor, change.source.id]),
        change,
      )
    },
    close: (): StagedOutbox => {
      staging.open = false

      return {
        intents: staging.intents,
        replaced: [...staging.replaced],
        jobs: staging.jobs,
        subscriptions: [...staging.subscriptions.values()],
        cancelledJobs: [...staging.cancelledJobs],
      }
    },
  }
}

const IntentSettings = Context.Reference<IntentOptions>("durable-actors/IntentSettings", {
  defaultValue: () => ({}),
})

/** Validates a job key (1-200 characters) and returns it prefixed as it is staged and stored. */
export const jobKey = (key: string) => {
  checkKey("A job key", key)

  return `${JOB_KEY_PREFIX}${key}`
}

const cancelJobKey = (staging: Staging, key: string) => {
  staging.jobs = staging.jobs.filter((job) => job.key !== key)
  staging.cancelledJobs.add(key)
}

const replaceKey = (staging: Staging, key: string) => {
  staging.intents = staging.intents.filter((intent) => intent.key !== key)
  staging.replaced.add(key)
}

/** The staging area of the running turn, checked against `marker` when given; dies once the turn ended, so a capability that escaped its turn stages nothing. */
export const currentStaging = Effect.fnUntraced(function* (marker?: InTurn["Service"]) {
  const current = yield* InTurn
  const staging = stagings.get(current)

  if (staging === undefined || !staging.open || (marker !== undefined && marker !== current))
    return yield* Effect.die(new Error("Intent capability escaped its turn"))

  return { marker: current, staging }
})

/**
 * Stages `intent` in the running turn's outbox with the ambient `Intent`
 * settings. The receiver sees the sending actor, attributed to the sending
 * turn's principal; only a minted child's creating intent carries the proof
 * that lets it create the child.
 */
export const stageIntent = Effect.fnUntraced(function* (
  marker: InTurn["Service"],
  intent: Pick<StagedIntent, "target" | "command" | "payload">,
) {
  const { staging } = yield* currentStaging(marker)
  const { due, key } = yield* IntentSettings

  const minted = staging.minted.get(mintKey(intent.target))

  const attribution = {
    source: due === undefined ? ("actor" as const) : ("timer" as const),
    ref: staging.sender,
    onBehalfOf: staging.onBehalfOf,
  }

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
    checkKey("Intent.key", key)

    if (key.startsWith(JOB_KEY_PREFIX)) throw new Error(`Intent key "${key}" is reserved for jobs`)

    if (isFrameworkKey(key)) throw new Error("Intent.key values starting with $ are reserved")

    return configure({ key })
  },
  /** Removes the sending actor's pending intent with `key` when this turn commits. */
  cancel: (key: string): Effect.Effect<void, never, InTurn> =>
    Effect.gen(function* () {
      if (key.startsWith(JOB_KEY_PREFIX))
        return yield* Effect.die(new Error(`Intent key "${key}" is reserved for jobs`))

      if (isFrameworkKey(key))
        return yield* Effect.die(new Error("Intent.key values starting with $ are reserved"))

      const { staging } = yield* currentStaging()
      replaceKey(staging, key)
    }),
}
