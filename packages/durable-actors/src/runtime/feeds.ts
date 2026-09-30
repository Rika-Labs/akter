import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { Sharding } from "effect/unstable/cluster"
import { SqlClient, SqlError } from "effect/unstable/sql"
import { ActorError, ActorUnavailable, NotCreated, SessionEnded } from "../errors/actor.ts"
import type { InternalActors } from "./actors.ts"
import type { Registration } from "./members.ts"
import type { Request } from "./request.ts"
import type { ActorRef } from "../identity/caller.ts"
import { StreamFailed, StreamItem } from "./connections/protocol.ts"
import { connectionEntity } from "./entity/register.ts"
import type { Transport } from "./connections/transport.ts"
import { withTenant } from "./database/tenancy.ts"
import { replayEvents } from "./events/replay.ts"
import { routingKey } from "./storage/codec.ts"
import type { FrameworkClock } from "./turn/admission.ts"

/** How often a subscriber checks that a stream's owner on another runner is alive. */
const OWNER_CHECK_INTERVAL = "1 second"

const activationEnded = () =>
  ActorError.make({ reason: SessionEnded.make({ cause: "ActivationEnded", resync: false }) })

/**
 * The runtime's feeds to one subscriber: a page of an actor's committed
 * events after a cursor, upcast to their current version, and a stream
 * member's live items from the actor's connection entity. A stream whose
 * owner lives on another runner is pinged and ends with `SessionEnded` once
 * that owner is gone.
 */
export const eventFeeds = ({
  registrations,
  services,
  allow,
  sharding,
  entityId,
  frameworkClock,
  transport,
}: {
  readonly registrations: ReadonlyMap<string, Registration>
  readonly services: Context.Context<SqlClient.SqlClient | Crypto.Crypto | Sharding.Sharding>
  readonly allow: (
    request: Request,
    kind?: "command" | "query" | "stream",
  ) => Effect.Effect<void, ActorError>
  readonly sharding: Sharding.Sharding["Service"]
  readonly entityId: (ref: ActorRef) => Effect.Effect<string>
  readonly frameworkClock: (typeof FrameworkClock)["Service"]
  readonly transport: Transport
}): Pick<InternalActors["Service"], "readFeed" | "subscribe"> => ({
  readFeed: Effect.fnUntraced(
    function* (
      ref: ActorRef,
      tags: ReadonlyArray<string>,
      after: string | undefined,
      limit: number,
    ) {
      const registration = registrations.get(ref.actor)

      if (registration === undefined)
        return yield* ActorError.make({
          reason: ActorUnavailable.make({ cause: new Error("Actor not registered") }),
        })

      const key = routingKey({ ref, placement: registration.placement })
      const sql = yield* SqlClient.SqlClient

      const events = yield* Effect.gen(function* () {
        const [row] = yield* sql<{ head: string }>`
          SELECT event_sequence::text AS head FROM actor_generations
          WHERE routing_key = ${key} AND tenant_id = ${ref.tenant}
            AND actor_type = ${ref.actor} AND actor_id = ${ref.id}`

        if (row === undefined) return yield* ActorError.make({ reason: NotCreated.make({}) })

        return yield* replayEvents(ref, key, tags, after, BigInt(row.head), limit)
      }).pipe(withTenant(ref.tenant))

      return yield* Effect.forEach(events, (event) =>
        registration.upcastEvent(event.tag, event.version, event.value).pipe(
          Effect.map((value) => ({
            cursor: event.cursor,
            tag: event.tag,
            commandId: event.commandId,
            value,
            timestampMs: event.timestampMs,
          })),
        ),
      )
    },
    Effect.provideContext(services),
    Effect.catchIf(SqlError.isSqlError, (cause) =>
      Effect.fail(ActorError.make({ reason: ActorUnavailable.make({ cause }) })),
    ),
  ),
  subscribe: (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const registration = registrations.get(request.ref.actor)

        if (registration === undefined || !registration.streams.has(request.command))
          return yield* ActorError.make({
            reason: ActorUnavailable.make({ cause: new Error("Stream not registered") }),
          })

        yield* allow(request, "stream")

        const client = (yield* sharding.makeClient(connectionEntity(request.ref.actor)))(
          yield* entityId(request.ref),
        )

        const authorizedUntil =
          (yield* Clock.currentTimeMillis) +
          frameworkClock.offsetMillis() +
          registration.policy.reauthorizeMs

        const started = yield* Deferred.make<{ owner: string; ownerEpoch: string }>()
        const lost = yield* Deferred.make<never, ActorError>()
        let owner: { owner: string; ownerEpoch: string } | undefined

        yield* Deferred.await(started).pipe(
          Effect.flatMap(({ owner, ownerEpoch }) =>
            owner === transport.holder
              ? Effect.never
              : transport.ping(owner, ownerEpoch).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced(OWNER_CHECK_INTERVAL),
                    while: (alive) => alive,
                  }),
                  Effect.andThen(Deferred.fail(lost, activationEnded())),
                ),
          ),
          Effect.forkScoped,
        )

        let finished = false

        return client
          .Subscribe({
            member: request.command,
            caller: request.caller,
            input: request.payload,
            authorizedUntil,
          })
          .pipe(
            Stream.tap((item) =>
              Effect.gen(function* () {
                if (StreamItem.guards.Done(item)) finished = true

                if (!StreamItem.guards.Started(item)) return

                if (owner !== undefined) return yield* activationEnded()
                owner = item
                yield* Deferred.succeed(started, item)
              }),
            ),
            Stream.takeWhile((item) => !StreamItem.guards.Done(item)),
            Stream.filter(StreamItem.guards.Element),
            Stream.map((item) => item.value),
            Stream.concat(
              Stream.fromEffect(
                Effect.suspend(() => (finished ? Effect.void : activationEnded())),
              ).pipe(Stream.drain),
            ),
            Stream.interruptWhen(Deferred.await(lost)),
            Stream.catchCause(
              (cause): Stream.Stream<never, ActorError | { readonly failure: string }> => {
                const failure = Cause.findErrorOption(cause)

                if (Option.isSome(failure)) {
                  if (Schema.is(ActorError)(failure.value)) return Stream.fail(failure.value)

                  if (Schema.is(StreamFailed)(failure.value))
                    return Stream.fail({ failure: failure.value.value })
                }

                if (Cause.hasInterruptsOnly(cause)) return Stream.fromEffect(Effect.interrupt)

                return Stream.fail(
                  owner === undefined
                    ? ActorError.make({
                        reason: ActorUnavailable.make({ cause: Cause.squash(cause) }),
                      })
                    : activationEnded(),
                )
              },
            ),
          )
      }).pipe(Effect.provideContext(services)),
    ),
})
