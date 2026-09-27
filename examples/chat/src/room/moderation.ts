import { Context, Effect, Layer } from "effect"

/**
 * The external moderation provider. `idempotencyKey` is the effect id, so a
 * provider that honours it charges a retried attempt once.
 */
export class ModerationApi extends Context.Service<
  ModerationApi,
  {
    readonly check: (
      body: string,
      options: { readonly idempotencyKey: string },
    ) => Effect.Effect<boolean>
  }
>()("@durable-actors/chat/room/moderation/ModerationApi") {
  /** Demo substitute: flags messages locally and does not claim provider-side idempotency. */
  static readonly layer = Layer.succeed(ModerationApi, {
    check: (body) => Effect.succeed(body.toLowerCase().includes("spam")),
  })
}

/**
 * Tells moderators about an appeal. An appeal's notify step calls it at least
 * once, so a real pager deduplicates on `messageId`: each message has one
 * appeal execution, keyed by that id.
 */
export class Moderators extends Context.Service<
  Moderators,
  { readonly notify: (messageId: string) => Effect.Effect<void> }
>()("@durable-actors/chat/room/moderation/Moderators") {
  /** Demo substitute: logs the appeal instead of paging anyone. */
  static readonly layer = Layer.succeed(Moderators, {
    notify: (messageId) => Effect.logInfo("appeal awaiting a moderator", messageId),
  })
}
