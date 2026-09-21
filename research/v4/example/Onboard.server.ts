// Workflow implementation: activities are persisted, so their output/errors need schemas.
import { Effect } from "effect"
import { Chat, InvalidMessage, Message, MessageAdded, NotAMember } from "./Chat.ts"
import { Onboard } from "./Onboard.ts"

export const OnboardLive = Onboard.toLayer((ctx, input) =>
  Effect.gen(function*() {
    // request/reply is fine inside a workflow: there is no turn to hold open, and delivery is the engine's problem
    const room = ctx.actors.get(Chat, input.roomId)
    yield* ctx.activity("welcome", {
      output: Message,
      errors: [InvalidMessage, NotAMember],
      // the framework pipes Actor.commandId(`${executionId}:welcome`), so a retry replays the receipt
      run: room.SendMessage({ id: `welcome-${input.userId}`, body: `welcome, ${input.userId}` })
    }).pipe(
      // an empty welcome message is not worth failing onboarding over
      Effect.catchTag("InvalidMessage", () => Effect.succeed(undefined))
    )
    // durable wait: resolved by the actor's next MessageAdded event, or None after the timeout
    const replied = yield* ctx.waitFor(Chat, input.roomId, MessageAdded, { timeout: "1 day" })
    if (replied._tag === "None") yield* ctx.sleep("1 day")
  })
)
