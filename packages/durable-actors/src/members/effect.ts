import { type Duration, Schema } from "effect"
import type { AnyCommand, ValueSchema } from "./command.ts"
import { declareChain, type PayloadMigrations } from "./payload.ts"

/**
 * An `Actor.effect` class: a schema-backed request for external I/O whose
 * instances a turn records with `turn.perform` and an executor runs after
 * commit. `success` types the executor's return value.
 */
export type EffectClass<
  Self,
  Tag extends string,
  Fields extends Schema.Struct.Fields,
  Success extends ValueSchema,
  Progress extends ValueSchema | undefined = undefined,
> = Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, {}> & {
  readonly tag: Tag
  readonly success: Success
  readonly progress: Progress
}

/** Any declared effect class, as listed in an actor's `effects` section. */
export type AnyEffect = ValueSchema & {
  readonly tag: string
  readonly success: ValueSchema
  readonly progress: ValueSchema | undefined
  readonly Type: { readonly _tag: string }
}

/** An effect class that declares a `progress` schema. */
export type ProgressEffect = AnyEffect & { readonly progress: ValueSchema }

/** The frame type an executor of `E` reports with `X.Executor.progress`. */
export type ProgressOf<E extends ProgressEffect> = E["progress"]["Type"]

/**
 * `Actor.effect`: declares an effect class. `input` holds the instance fields; `success` is
 * the schema of the executor's return value and defaults to `void`.
 * `progress`, when declared, is the schema of the transient frames its
 * executor may report before the result commits; they are never state.
 * `migrations` upcasts payloads stored at older versions before each attempt
 * and before a dead letter's route; `writeVersion` is as for events.
 */
export const effect =
  <Self = never>() =>
  <
    const Tag extends string,
    const Fields extends Schema.Struct.Fields = {},
    Success extends ValueSchema = Schema.Void,
    Progress extends ValueSchema | undefined = undefined,
  >(
    tag: Tag,
    options?: {
      readonly input?: Fields
      readonly success?: Success
      readonly progress?: Progress
      readonly migrations?: PayloadMigrations
      readonly writeVersion?: number
    },
  ): [Self] extends [never]
    ? "Missing Self generic: Actor.effect<Self>()(tag, options)"
    : EffectClass<Self, Tag, Fields, Success, Progress> => {
    if (tag.length === 0) throw new Error("Actor.effect needs a non-empty tag")
    const base = Schema.TaggedClass<unknown>()(tag, options?.input ?? {})
    declareChain({
      schema: base,
      label: `Effect ${tag}`,
      fields: (options?.input ?? {}) as never,
      options,
    })

    return Object.assign(class extends base {}, {
      tag,
      success: options?.success ?? Schema.Void,
      progress: options?.progress,
    }) as never
  }

/**
 * The input of an `onDeadLetter` command. `ambiguous` is true when the last
 * attempt ended without a known outcome (a crash, timeout, interruption, or
 * defect), so the provider may still have applied it.
 */
export const DeadLetter = <E extends AnyEffect>(effect: E) =>
  Schema.Struct({
    effectId: Schema.String,
    effect,
    attempts: Schema.Int,
    cause: Schema.String,
    ambiguous: Schema.Boolean,
  })

/** The decoded input of an `onDeadLetter` command for effect class `E`. */
export type DeadLetter<E extends AnyEffect> = ReturnType<typeof DeadLetter<E>>["Type"]

/**
 * The input of an `onCancelled` command: what is known of a cancelled
 * effect. `Succeeded` carries the provider's result; `Failed` is reported only
 * when no attempt can have applied the call; every other case is `Unknown`,
 * with `ambiguous` true, because the provider may have acted.
 */
export const Cancelled = <E extends AnyEffect>(effect: E) =>
  Schema.Struct({
    effectId: Schema.String,
    effect,
    attempts: Schema.Int,
    outcome: Schema.TaggedUnion({
      Succeeded: { value: effect.success },
      Failed: { cause: Schema.String },
      Unknown: { cause: Schema.String },
    }),
    ambiguous: Schema.Boolean,
  })

/** The decoded input of an `onCancelled` command for effect class `E`. */
export type Cancelled<E extends AnyEffect> = ReturnType<typeof Cancelled<E>>["Type"]

/** A cancelled effect's outcome before its route decodes `value`. */
export const CancelledOutcome = Schema.TaggedUnion({
  Succeeded: { value: Schema.Unknown },
  Failed: { cause: Schema.String },
  Unknown: { cause: Schema.String },
})

/** Commands whose input accepts `T`. */
type Accepting<Command extends AnyCommand, T> = Command extends AnyCommand
  ? [T] extends [Command["input"]["Type"]]
    ? Command
    : never
  : never

/**
 * One effect's policy. Routes must name commands of this actor whose input
 * accepts the executor's return type or the effect's dead letter.
 */
export interface EffectPolicy<E extends AnyEffect, Command extends AnyCommand> {
  /** Bounds one executor attempt, measured on the runner. Default 30 seconds. */
  readonly timeout?: Duration.Input
  /**
   * The least time between two progress frames one attempt sends; frames
   * reported sooner replace the one waiting. Default 250 milliseconds, from
   * 50 milliseconds to 1 minute.
   */
  readonly progressEvery?: Duration.Input
  /**
   * Retries after the first failed attempt (default 3), and the wait after
   * failed attempt `n`: `min(base × 2^(n − 1), max)`. Default base 1 second,
   * max 256 seconds.
   */
  readonly retry?: {
    readonly times: number
    readonly backoff?: { readonly base: Duration.Input; readonly max: Duration.Input }
  }
  /** Receives the executor's return value, with the effect id as its command id. */
  readonly onSuccess?: Accepting<Command, E["success"]["Type"]>
  /** Receives `Actor.DeadLetter(E)` once when retries are exhausted. */
  readonly onDeadLetter?: Accepting<Command, DeadLetter<E>>
  /**
   * Receives `Actor.Cancelled(E)` once for an effect cancelled after an
   * attempt started, with the effect id as its command id.
   */
  readonly onCancelled?: Accepting<Command, Cancelled<E>>
  /**
   * Attempts of this effect running at once for one actor, across every
   * runner: an integer from 1 to 64. Unlimited when omitted.
   */
  readonly concurrency?: { readonly perActor: number }
}

/** Per-effect policies keyed by effect tag; see `EffectPolicy`. */
export type EffectPolicies<Effects extends AnyEffect, Command extends AnyCommand> = {
  readonly [Tag in Effects["tag"]]?: EffectPolicy<Extract<Effects, { readonly tag: Tag }>, Command>
}
