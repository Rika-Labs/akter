import { Option, Schema } from "effect"

export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  commandId: Schema.String,
}) {}

export class CommandExpired extends Schema.TaggedError<CommandExpired>()("CommandExpired", {
  commandId: Schema.String,
}) {}

export class InvalidCommandId extends Schema.TaggedError<InvalidCommandId>()("InvalidCommandId", {
  commandId: Schema.String,
}) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  code: Schema.Literals(["access_denied", "receipt_access_denied"]),
}) {}

export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  cause: Schema.Defect(),
}) {}

export const Reason = Schema.Union([
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
  ActorUnavailable,
])

export type Reason = typeof Reason.Type

export class ActorError extends Schema.TaggedError<ActorError>()("ActorError", { reason: Reason }) {
  get isRetryable(): boolean {
    return Schema.is(ActorUnavailable)(this.reason)
  }

  get retryAfter(): Option.Option<number> {
    return Option.none()
  }

  override get message(): string {
    return this.reason.message
  }
}
