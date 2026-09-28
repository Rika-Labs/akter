import { Context, Effect, Schema } from "effect"
import type { Request } from "../../handles/actors.ts"

export type TurnPoint =
  | "beforeDelivery"
  | "beforeHandler"
  | "beforeCommit"
  | "afterCommit"
  | "beforeFlush"
  | "afterClaim"
  | "beforeOutboxDelete"
  | "beforeExecute"
  | "afterExecute"
  | "beforeRenew"
  | "beforeDeadLetterCommit"

export class RetryTurn extends Schema.TaggedError<RetryTurn>()("RetryTurn", {
  message: Schema.String,
}) {}

export const TurnHooks = Context.Reference<{
  readonly at: (point: TurnPoint, request: Request) => Effect.Effect<void>
}>("durable-actors/TurnHooks", {
  defaultValue: () => ({ at: () => Effect.void }),
})

/**
 * Test controls for retention cleanup: rows per batch statement, a point
 * after each committed batch where a test can pause or crash the sweep, and
 * whether the runtime sweeps on its own every minute.
 */
export const CleanupHooks = Context.Reference<{
  readonly batchSize: number
  readonly afterBatch: Effect.Effect<void>
  readonly periodic: boolean
}>("durable-actors/CleanupHooks", {
  defaultValue: () => ({ batchSize: 1000, afterBatch: Effect.void, periodic: true }),
})
