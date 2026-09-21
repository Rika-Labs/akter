// Server file: Effect form — services and per-activation state are acquired once, not per command.
import { Context, Effect, Option, Ref, Stream } from "effect"
import type { ActorRef, Caller } from "../framework/Actor.ts"
import {
  Chat,
  EmailDelivered,
  InvalidMessage,
  Message,
  MessageAdded,
  messages,
  NotAMember,
  SendEmail
} from "./Chat.ts"
import { Counter, CounterId } from "./Counter.ts"
import { Mailer } from "./Mailer.ts"

export class RoomAccess extends Context.Service<RoomAccess, {
  readonly requireMember: (caller: Caller, room: ActorRef) => Effect.Effect<void, NotAMember>
}>()("app/RoomAccess") {}

export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    const mailer = yield* Mailer
    // per-activation state is a closure, not a framework-owned slot
    const typing = yield* Ref.make(new Set<string>())

    return Chat.of({
      SendMessage: Effect.fn(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.ref)
        const body = input.body.trim()
        if (body.length === 0) return yield* new InvalidMessage({ reason: "empty" })
        if (body.length > 4_000) return yield* new InvalidMessage({ reason: "too_long" })

        const authorId = Option.getOrElse(Option.map(ctx.principal, (p) => p.userId), () => "system")
        const message = new Message({ id: ctx.commandId, authorId, body, sentAt: ctx.now })
        // pre-scoped to (tenant_id, actor_id); the insert joins the turn transaction
        yield* ctx.rows(messages).insert({ id: message.id, author_id: authorId, body, sent_at: ctx.now })
        yield* ctx.emit(new MessageAdded({ message }))
        yield* ctx.perform(new SendEmail({ messageId: message.id, to: "room@example.com", body }))
        // cross-actor durable intent, same transaction
        yield* ctx.actors.get(Counter, CounterId.make("messages-sent")).Increment.send(1)
        // queued inside a command, flushed after COMMIT (like emit, but not persisted)
        yield* ctx.connections.broadcast(message)
        yield* Effect.logInfo("message appended") // actor/id/commandId annotated by turn()
        return message
      }),
      // internal: only an executor, a timer or another actor can reach it
      MarkDelivered: (ctx, { messageId }) => ctx.emit(new EmailDelivered({ messageId })),
      // runs on the actor's node, forked past the mailbox: events, not rows
      Transcript: (ctx) =>
        Stream.fromEffect(access.requireMember(ctx.caller, ctx.ref)).pipe(
          Stream.flatMap(() => ctx.events(MessageAdded)),
          Stream.map((e) => e.event.message)
        ),
      // the returned stream is this connection's outbound; `broadcast` reaches every other one
      Live: (ctx, params, inbound) =>
        Stream.fromEffect(access.requireMember(ctx.caller, ctx.ref)).pipe(
          Stream.flatMap(() =>
            Stream.merge(
              ctx.events(MessageAdded, { after: params.since ?? 0 }).pipe(Stream.map((e) => e.event.message)),
              inbound.pipe(
                Stream.tap((t) =>
                  // per-connection state lives in memory on the activation
                  ctx.conn.state.set({ typingSince: ctx.now }).pipe(
                    Effect.andThen(ctx.connections.broadcast(t, { except: ctx.conn.id }))
                  )
                ),
                Stream.drain
              )
            )
          )
        )
    }, {
      hooks: [
        Chat.onWake(() => Ref.set(typing, new Set())),
        Chat.onEffectFailed((_ctx, _effect, cause) => Effect.logError("effect dead-lettered", cause))
      ],
      effects: {
        // `(ctx, effect)`: the same argument order as every other handler
        SendEmail: (ctx, effect) =>
          mailer.send(effect.to, effect.body).pipe(
            // the result returns to the actor as an intent, not as a return value
            Effect.andThen(ctx.self.MarkDelivered.send({ messageId: effect.messageId }))
          )
      }
    })
  })
)
