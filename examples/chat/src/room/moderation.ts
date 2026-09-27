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
