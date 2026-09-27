import type { DateTime, Duration, Effect, Option } from "effect"
import type { ActorRef, Principal } from "../identity/caller.ts"
import type { AnyEffect } from "../members/effect.ts"

/** How `turn.perform` names and schedules an effect. */
export interface PerformOptions {
  /**
   * Names the effect within its actor, 1-200 characters. Performing another
   * effect with the same key replaces this one when the turn commits, as
   * `turn.cancelEffect(key)` would.
   */
  readonly key?: string
  /** Runs no earlier than `after` past the turn's commit. */
  readonly after?: Duration.Input
  /** Runs no earlier than `at`, measured on the database clock. */
  readonly at?: DateTime.DateTime
}

/** The part of a command turn that records effects; see `X.Turn`. */
export interface PerformContext<E extends AnyEffect> {
  /**
   * Records `effect` in this turn. It is executed only after the turn commits,
   * and a declared failure or rollback discards it.
   */
  readonly perform: (effect: E["Type"], options?: PerformOptions) => Effect.Effect<void>
  /**
   * Cancels this actor's effect with `key` when the turn commits. One that
   * never started is removed; one that started is never attempted again and
   * reports what is known of it to `onCancelled`.
   */
  readonly cancelEffect: (key: string) => Effect.Effect<void>
}

/** The context of one executor attempt, obtained with `yield* X.Executor`. */
export interface ExecutorContext {
  /** Stable across every attempt; use it as the provider's idempotency key. */
  readonly effectId: string
  /** 1 on the first attempt; a later attempt may follow one whose outcome is unknown. */
  readonly attempt: number
  /** The principal of the turn that performed the effect. */
  readonly principal: Option.Option<Principal>
  /** The actor that performed the effect. */
  readonly ref: ActorRef
}
