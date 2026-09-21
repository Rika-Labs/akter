// Workflow implementation: activities are persisted, so their output/errors need schemas.
import { Effect, Option, Schedule, Schema } from "effect"
import { Chat, InvalidMessage, Message, MessageAdded, NotAMember } from "./Chat.ts"
import { Mailer } from "./Mailer.ts"
import { Onboard } from "./Onboard.ts"

export const OnboardLive = Onboard.toLayer((ctx, { userId, roomId }) =>
  Effect.gen(function*() {
    // System("workflow", onBehalfOf: starter); request/reply is fine here, there is no turn to hold open
    const room = ctx.actors.get(Chat, roomId)
    yield* ctx.activity("welcome", {
      output: Message,
      errors: [InvalidMessage, NotAMember],
      // the framework pipes Actor.commandId(`${executionId}:welcome`), so a retry replays the receipt
      run: room.SendMessage({ body: `welcome, ${userId}` }),
      retry: Schedule.exponential("1 second")
      // an empty welcome message is not worth failing onboarding over
    }).pipe(Effect.catchTag("InvalidMessage", () => Effect.void))

    // durable wait: resolved by the room's next MessageAdded event, or None after the timeout
    const first = yield* ctx.waitFor(Chat, roomId, MessageAdded, { timeout: "1 day" })
    if (Option.isSome(first)) return { nudged: false }

    yield* ctx.activity("nudge", {
      output: Schema.Void,
      // `errors: []` spelled out: omitting it leaves `Errors` at its constraint and widens the activity's E
      errors: [],
      run: Effect.flatMap(Mailer, (m) => m.send(userId, "still there?")).pipe(Effect.orDie)
    })
    yield* ctx.sleep("1 day") // DurableClock: survives a restart
    return { nudged: true }
  })
)
