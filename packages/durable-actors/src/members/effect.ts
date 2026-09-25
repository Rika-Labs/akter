import { Schema } from "effect"
import type { AnyCommand, ValueSchema } from "./command.ts"

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
> = Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, {}> & {
  readonly tag: Tag
  readonly success: Success
}

/** Any declared effect class, as listed in an actor's `effects` section. */
export type AnyEffect = ValueSchema & {
  readonly tag: string
  readonly success: ValueSchema
  readonly Type: { readonly _tag: string }
}

/**
 * Declares an effect class. `input` holds the instance fields; `success` is
 * the schema of the executor's return value and defaults to `void`.
 */
export const effect =
  <Self = never>() =>
  <
    const Tag extends string,
    const Fields extends Schema.Struct.Fields = {},
    Success extends ValueSchema = Schema.Void,
  >(
    tag: Tag,
    options?: { readonly input?: Fields; readonly success?: Success },
  ): [Self] extends [never]
    ? "Missing Self generic: Actor.effect<Self>()(tag, options)"
    : EffectClass<Self, Tag, Fields, Success> => {
    if (tag.length === 0) throw new Error("Actor.effect needs a non-empty tag")
    const base = Schema.TaggedClass<unknown>()(tag, options?.input ?? {})

    return Object.assign(class extends base {}, {
      tag,
      success: options?.success ?? Schema.Void,
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

export type DeadLetter<E extends AnyEffect> = ReturnType<typeof DeadLetter<E>>["Type"]

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
  /** Retries after the first failed attempt. Default 3. */
  readonly retry?: { readonly times: number }
  /** Receives the executor's return value, with the effect id as its command id. */
  readonly onSuccess?: Accepting<Command, E["success"]["Type"]>
  /** Receives `Actor.DeadLetter(E)` once when retries are exhausted. */
  readonly onDeadLetter?: Accepting<Command, DeadLetter<E>>
}

export type EffectPolicies<Effects extends AnyEffect, Command extends AnyCommand> = {
  readonly [Tag in Effects["tag"]]?: EffectPolicy<Extract<Effects, { readonly tag: Tag }>, Command>
}
