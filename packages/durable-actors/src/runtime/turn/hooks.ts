import { Context, Effect, Schema } from "effect"
import type { Request } from "../../handles/actors.ts"

export type TurnPoint =
  | "beforeDelivery"
  | "beforeHandler"
  | "beforeCommit"
  | "afterCommit"
  | "beforeOutboxDelete"
  | "beforeExecute"
  | "afterExecute"

export class RetryTurn extends Schema.TaggedError<RetryTurn>()("RetryTurn", {
  message: Schema.String,
}) {}

export const TurnHooks = Context.Reference<{
  readonly at: (point: TurnPoint, request: Request) => Effect.Effect<void>
}>("durable-actors/TurnHooks", {
  defaultValue: () => ({ at: () => Effect.void }),
})
