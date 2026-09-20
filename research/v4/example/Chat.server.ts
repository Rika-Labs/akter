// Server file: Effect form — services are acquired once per activation, not per command.
import { Context, Effect } from "effect"
import type { EntityAddress } from "effect/unstable/cluster"
import type { Caller } from "../framework/Actor.ts"
import { Chat, InvalidMessage, Message, MessageAdded, NotAMember } from "./Chat.ts"

export class RoomAccess extends Context.Service<RoomAccess, {
  readonly requireMember: (caller: Caller, room: EntityAddress.EntityAddress) => Effect.Effect<void, NotAMember>
}>()("app/RoomAccess") {}

export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    return Chat.of({
      SendMessage: Effect.fn("Chat.SendMessage")(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        const body = input.body.trim()
        if (body.length === 0) return yield* new InvalidMessage({ reason: "empty" })
        const message = new Message({ id: input.id, authorId: ctx.caller.userId, body, sentAt: ctx.now })
        yield* ctx.emit(new MessageAdded({ message }))
        return message
      }),
      Recent: Effect.fn("Chat.Recent")(function*(ctx, _input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        return [] as Array<Message>
      })
    })
  })
)
