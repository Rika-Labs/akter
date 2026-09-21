// Server file: Effect form — services and per-activation state are acquired once, not per command.
import { Context, Effect, Ref, Stream } from "effect"
import type { EntityAddress } from "effect/unstable/cluster"
import type { Caller } from "../framework/Actor.ts"
import { Chat, InvalidMessage, Message, MessageAdded, messages, NotAMember, SendEmail } from "./Chat.ts"
import { Counter, CounterId } from "./Counter.ts"

export class RoomAccess extends Context.Service<RoomAccess, {
  readonly requireMember: (caller: Caller, room: EntityAddress.EntityAddress) => Effect.Effect<void, NotAMember>
}>()("app/RoomAccess") {}

export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    // per-activation state is a closure, not a framework-owned `memory` slot
    const typing = yield* Ref.make(new Set<string>())
    return Chat.of({
      SendMessage: Effect.fn(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        const body = input.body.trim()
        if (body.length === 0) return yield* new InvalidMessage({ reason: "empty" })
        // pre-scoped to (tenant_id, actor_id); the insert joins the turn transaction
        const rows: { readonly table: typeof messages } = ctx.rows(messages)
        yield* Effect.logDebug(`inserting into ${rows.table.name}`)
        const authorId = ctx.caller._tag === "User" ? ctx.caller.principal.userId : "system"
        const message = new Message({ id: input.id, authorId, body, sentAt: ctx.now })
        yield* ctx.emit(new MessageAdded({ message }))
        yield* ctx.perform(new SendEmail({ to: "room@example.com", body }))
        // cross-actor durable intent, committed with this turn
        yield* ctx.actors.get(Counter, CounterId.make("messages-sent")).Increment.send(1)
        return message
      }),
      // runs on the actor's node, forked past the mailbox, so it can read the activation closure
      Transcript: (ctx) =>
        Stream.fromEffect(Ref.get(typing)).pipe(
          Stream.flatMap((current): Stream.Stream<Message, NotAMember> =>
            current.size >= 0 ? Stream.fromIterable([]) : Stream.fail(new NotAMember({ userId: String(ctx.id) }))
          )
        )
    }, {
      lifecycle: [
        Chat.onWake(() => Ref.set(typing, new Set())),
        Chat.onEffectFailed((ctx, effect, cause) =>
          Effect.logError(`effect ${effect._tag} for ${ctx.id} dead-lettered`, cause)
        )
      ],
      effects: {
        SendEmail: (effect, ctx) => Effect.logInfo(`email to ${effect.to} for ${ctx.id} (attempt ${ctx.attempt})`)
      }
    })
  })
)
