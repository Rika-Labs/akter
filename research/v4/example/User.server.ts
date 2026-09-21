// Server file: command handlers and the workflow body side by side (decision 158). Activities are persisted, so their
// output/errors need schemas.
import { Effect, Option, Schedule, Schema } from "effect"
import { Chat, InvalidMessage, Message, NotAMember } from "./Chat.ts"
import { Mailer } from "./Mailer.ts"
import { FirstMessage, Joined, User } from "./User.ts"

export const UserLive = User.toLayer(
  Effect.gen(function*() {
    const mailer = yield* Mailer

    return User.of({
      Join: Effect.fn(function*(ctx, { roomId }) {
        if (roomId in ctx.state.rooms) return
        yield* ctx.state.set({ rooms: { ...ctx.state.rooms, [roomId]: false } })
        yield* ctx.emit(new Joined({ roomId }))
        // a workflow intent: the engine starts the run after COMMIT; the same key joins a live run instead of duplicating it
        yield* ctx.self.Onboard.start({ roomId }, { key: roomId })
      }),
      NoteMessage: Effect.fn(function*(ctx, { roomId, messageId }) {
        if (ctx.state.rooms[roomId] === true) return
        yield* ctx.state.set({ rooms: { ...ctx.state.rooms, [roomId]: true } })
        yield* ctx.emit(new FirstMessage({ roomId, messageId }))
      }),

      // the workflow body: `ctx` is a WorkflowContext, the caller is System("workflow", { onBehalfOf: whoever ran Join })
      Onboard: Effect.fn(function*(ctx, { roomId }) {
        // request/reply is fine here: there is no turn to hold open
        const room = ctx.actors.get(Chat, roomId)
        yield* ctx.activity("welcome", {
          output: Message,
          errors: [InvalidMessage, NotAMember],
          // the framework pipes Actor.commandId(`${executionId}:welcome`), so a retry replays the receipt
          run: room.SendMessage({ body: `welcome, ${ctx.owner.id}` }),
          retry: Schedule.exponential("1 second")
        }).pipe(
          // an empty welcome message is not worth failing onboarding over
          Effect.catchTag("InvalidMessage", () => Effect.void)
        )

        // durable wait on the owner's own events (decision 166): resolved by the next FirstMessage for this room, or None after a day
        const first = yield* ctx.waitFor(FirstMessage, { where: (e) => e.roomId === roomId, timeout: "1 day" })
        if (Option.isSome(first)) return { nudged: false }

        yield* ctx.activity("nudge", {
          output: Schema.Void,
          errors: [], // spelled out: omitting it leaves `Errors` at its constraint and widens the activity's E
          run: mailer.send(ctx.owner.id, "still there?").pipe(Effect.orDie)
        })
        yield* ctx.sleep("1 day") // DurableClock: survives a restart
        return { nudged: true }
      })
    })
  })
)
