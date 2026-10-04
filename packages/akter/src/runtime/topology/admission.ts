import { Context, Effect, Exit, Layer, Predicate, Schema } from "effect"
import { ClusterError, EntityAddress, Reply, Sharding } from "effect/cluster"
import { ActorError } from "../../errors/actor.ts"
import { commandEntity } from "../entity/register.ts"

/** The owner classifies transient capacity errors using its own activation residency. */
export class MailboxRefusals extends Context.Service<
  MailboxRefusals,
  { refuse: (address: EntityAddress.EntityAddress) => ActorError | undefined }
>()("@rikalabs/akter/runtime/topology/admission/MailboxRefusals") {}

export const mailboxRefusals = Layer.sync(MailboxRefusals, () => ({ refuse: () => undefined }))

/** Returns resident mailbox refusals through Execute's typed reply instead of a transport error. */
export const admissionSharding = Layer.effect(
  Sharding.Sharding,
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding
    const refusals = yield* MailboxRefusals

    return Sharding.Sharding.of({
      ...sharding,
      send: (message) =>
        sharding.send(message).pipe(
          Effect.catchIf(Schema.is(ClusterError.MailboxFull), (error) =>
            Effect.gen(function* () {
              if (
                !Predicate.isTagged(message, "IncomingRequest") ||
                message.envelope.tag !== "Execute"
              )
                return yield* error

              const refusal = refusals.refuse(error.address)
              if (refusal === undefined) return yield* error

              const reply = new Reply.WithExit({
                id: yield* sharding.getSnowflake,
                requestId: message.envelope.requestId,
                exit: Exit.fail(refusal),
              })

              yield* message
                .respond(
                  new Reply.ReplyWithContext({
                    reply,
                    rpc: commandEntity(error.address.entityType).protocol.requests.get("Execute")!,
                    context: Context.empty(),
                  }),
                )
                .pipe(Effect.orDie)
            }),
          ),
        ),
    })
  }),
).pipe(Layer.provide(Sharding.layer))
