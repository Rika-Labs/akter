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

export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  commandId: Schema.String,
}) {}

export class NotCreated extends Schema.TaggedError<NotCreated>()("NotCreated", {}) {}

export class MailboxFull extends Schema.TaggedError<MailboxFull>()("MailboxFull", {}) {}

/**
 * The runner already holds its `maxResidentActors` activations and cannot
 * start another, so the command was not admitted. It says nothing about an
 * earlier attempt with the same command id, which may have committed.
 */
export class RunnerAtCapacity extends Schema.TaggedError<RunnerAtCapacity>()(
  "RunnerAtCapacity",
  {},
) {}

export const Reason = Schema.Union([
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
  ActorUnavailable,
  Timeout,
  NotCreated,
  MailboxFull,
  RunnerAtCapacity,
])

export type Reason = typeof Reason.Type

export class ActorError extends Schema.TaggedError<ActorError>()("ActorError", { reason: Reason }) {
  get isRetryable(): boolean {
    return Schema.is(Schema.Union([ActorUnavailable, Timeout, MailboxFull, RunnerAtCapacity]))(
      this.reason,
    )
  }

  get retryAfter(): Option.Option<number> {
    return Option.none()
  }

  override get message(): string {
    return this.reason.message
  }
}

export namespace ActorError {
  export type Of<Reasons extends Reason["_tag"]> = [Reasons] extends [never]
    ? never
    : ActorError & { readonly reason: Extract<Reason, { readonly _tag: Reasons }> }
}
