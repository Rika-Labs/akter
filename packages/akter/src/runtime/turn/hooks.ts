import { Context, Effect, Schema } from "effect"
import type { Request } from "../request.ts"

/**
 * A named moment in command delivery, turn execution, and the outbox and
 * subscription relays where a test can pause, fail, or crash the runtime.
 */
export type TurnPoint =
  | "beforeDelivery"
  | "queued"
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

/**
 * A defect that says nothing about the command: the activation restarts and
 * the caller retries the same command id. Tests raise it to inject a crash.
 */
export class RetryTurn extends Schema.TaggedError<RetryTurn>()("RetryTurn", {
  message: Schema.String,
}) {}

/**
 * Called at each `TurnPoint` with the request in flight. The default does
 * nothing; a test hook can wait, fail, or die at that point. A hook that dies
 * with `RetryTurn` simulates a crash the runtime recovers from.
 */
export const TurnHooks = Context.Reference<{
  readonly at: (point: TurnPoint, request: Request) => Effect.Effect<void>
}>("akter/TurnHooks", {
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
}>("akter/ContentHooks", {
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
}>("akter/CleanupHooks", {
  defaultValue: () => ({ batchSize: 1000, afterBatch: Effect.void, periodic: true }),
})
