// Server file: Effect form — services are acquired once per activation, not per command.
import { Context, Effect, Ref, Stream } from "effect"
import type { EntityAddress } from "effect/unstable/cluster"
import type { CallerInfo } from "../framework/Actor.ts"
import { Chat, InvalidMessage, Message, MessageAdded, messages, NotAMember, SendEmail } from "./Chat.ts"
import { Counter, CounterId } from "./Counter.ts"

export class RoomAccess extends Context.Service<RoomAccess, {
  readonly requireMember: (caller: CallerInfo, room: EntityAddress.EntityAddress) => Effect.Effect<void, NotAMember>
}>()("app/RoomAccess") {}

export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    return Chat.of({
      SendMessage: Effect.fn("Chat.SendMessage")(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        const body = input.body.trim()
        if (body.length === 0) return yield* new InvalidMessage({ reason: "empty" })
        // pre-scoped to (tenant_id, actor_id); the insert joins the turn transaction
        const rows: { readonly table: typeof messages } = ctx.rows(messages)
        yield* Effect.logDebug(`inserting into ${String(rows.table)}`)
        const message = new Message({ id: input.id, authorId: ctx.caller.userId, body, sentAt: ctx.now })
        yield* ctx.emit(new MessageAdded({ message }))
        yield* ctx.perform(new SendEmail({ to: "room@example.com", body }))
        // cross-actor durable intent, committed with this turn
        yield* ctx.actors.get(Counter, CounterId.make("messages-sent")).Increment.send(1)
        return message
      }),
      Recent: Effect.fn("Chat.Recent")(function*(ctx, _input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        return [] as Array<Message>
      }),
      // runs on the actor's node, forked past the mailbox, so it can read activation memory
      Transcript: (ctx) =>
        Stream.fromEffect(Ref.get(ctx.memory)).pipe(
          Stream.flatMap((memory): Stream.Stream<Message, NotAMember> =>
            memory.typing.size >= 0 ? Stream.fromIterable([]) : Stream.fail(new NotAMember({ userId: ctx.caller.userId }))
          )
        )
    })
  }),
  {
    effects: {
      SendEmail: (effect, ctx) => Effect.logInfo(`email to ${effect.to} for ${ctx.id} (attempt ${ctx.attempt})`)
    },
    lifecycle: [Chat.onWake((ctx) => Effect.logInfo(`room awake: ${ctx.id}`))]
  }
)
