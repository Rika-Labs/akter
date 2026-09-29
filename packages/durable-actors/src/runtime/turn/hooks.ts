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
  | "beforeSettle"
  | "afterSettleSnapshot"
  | "afterExpand"
  | "beforeWorkflowSuspend"

export class RetryTurn extends Schema.TaggedError<RetryTurn>()("RetryTurn", {
  message: Schema.String,
}) {}

export const TurnHooks = Context.Reference<{
  readonly at: (point: TurnPoint, request: Request) => Effect.Effect<void>
}>("durable-actors/TurnHooks", {
  defaultValue: () => ({ at: () => Effect.void }),
})

/**
 * Where a test can pause a content operation between its two single-shard
 * statements: a read after resolving the reference, the sweep after its
 * reference scan, and `Content.grant` before it raises the grant horizon.
 */
export type ContentPoint = "afterResolve" | "afterReferenceScan" | "beforeRaise"

export const ContentHooks = Context.Reference<{
  readonly at: (point: ContentPoint) => Effect.Effect<void>
}>("durable-actors/ContentHooks", {
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
