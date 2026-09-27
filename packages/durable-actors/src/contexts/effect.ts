import type { Effect, Option } from "effect"
import type { ActorRef, Principal } from "../identity/caller.ts"
import type { AnyEffect, ProgressEffect, ProgressOf } from "../members/effect.ts"

/** The part of a command turn that records effects; see `X.Turn`. */
export interface PerformContext<E extends AnyEffect> {
  /**
   * Records `effect` in this turn. It is executed only after the turn commits,
   * and a declared failure or rollback discards it.
   */
  readonly perform: (effect: E["Type"]) => Effect.Effect<void>
}

/** The context of one executor attempt, obtained with `yield* X.Executor`. */
export interface ExecutorContext<E extends AnyEffect = AnyEffect> {
  /** Stable across every attempt; use it as the provider's idempotency key. */
  readonly effectId: string
  /** 1 on the first attempt; a later attempt may follow one whose outcome is unknown. */
  readonly attempt: number
  /** The principal of the turn that performed the effect. */
  readonly principal: Option.Option<Principal>
  /** The actor that performed the effect. */
  readonly ref: ActorRef
  /**
   * Reports a transient progress frame of the running effect `effect`. It
   * never fails or waits and never changes the outcome: a frame that does not
   * encode, exceeds 4 KiB, names another effect, or runs after the attempt
   * ended is dropped. Frames are coalesced and may be lost; they are never
   * state, events, or receipts.
   */
  progress<P extends Extract<E, ProgressEffect>>(
    effect: P,
    frame: ProgressOf<P>,
  ): Effect.Effect<void>
}
