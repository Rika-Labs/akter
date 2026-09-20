// Workflow implementation: activities are persisted, so their output/errors need schemas.
import { Effect } from "effect"
import { Chat, InvalidMessage, Message, NotAMember } from "./Chat.ts"
import { Onboard } from "./Onboard.ts"

export const OnboardLive = Onboard.toLayer((ctx, input) =>
  Effect.gen(function*() {
    // request/reply is fine inside a workflow: there is no turn to hold open
    const room = ctx.actors.get(Chat, input.roomId)
    yield* ctx.activity("welcome", {
      output: Message,
      errors: [InvalidMessage, NotAMember],
      // delivery failures are retryable: make them defects so the activity retries instead of persisting them
      run: room.SendMessage({ id: `welcome-${input.userId}`, body: `welcome, ${input.userId}` }).pipe(
        Effect.catchTags({ ActorUnavailable: Effect.die, CommandConflict: Effect.die })
      )
    }).pipe(
      // an empty welcome message is not worth failing onboarding over
      Effect.catchTag("InvalidMessage", () => Effect.succeed(undefined))
    )
    yield* ctx.sleep("1 day")
  })
)
