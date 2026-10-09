import { Cause, Effect, Exit, Fiber, Queue, Schedule, Stream } from "effect"
import type { SqlClient } from "effect/sql"
import { ActorError, RunnerAtCapacity, SessionEnded, Unauthorized } from "../../errors/actor.ts"
import type { ActorRef, Caller } from "../../identity/caller.ts"
import type { Registration, StreamInput } from "../members.ts"
import type { Activation } from "./owner.ts"
import { StreamFailed, StreamItem } from "./protocol.ts"
import type { Transport } from "./transport.ts"
import { ColdRead } from "../turn/blobs.ts"

/** Open stream subscriptions one actor may have. */
const MAX_ACTOR_STREAMS = 256

/** Stream elements held for one subscriber before its handler waits. */
const STREAM_WINDOW = 256

/** How long a stream's window may stay full before the subscription ends. */
const STREAM_STALL_MS = 30_000

/** How often the owner checks subscriptions' authorization and windows. */
const STREAM_TICK = "100 millis"

/** One live subscription, owned until its subscriber or activation ends. */
export interface Subscription {
  readonly member: string
  readonly caller: Caller
  /** When authorization last succeeded, on the framework clock. */
  lastAuthorized: number
  checking: boolean
  /** Since when the handler has waited on a full window. */
  stalledSince: number | undefined
  readonly end: (error: ActorError, discard: boolean) => Effect.Effect<void>
}

/** Decides whether a caller may open a stream or renew its access; `false` refuses. */
export type Authorize = (request: {
  readonly caller: Caller
  readonly ref: ActorRef
  readonly command: string
  readonly kind: "stream" | "reauthorize"
  /** A stream tag must not be interpreted as a feed event tag. */
  readonly of?: "stream"
}) => Effect.Effect<boolean>

const unauthorized = (code: "access_denied" | "reauthorization_unavailable") =>
  ActorError.make({ reason: Unauthorized.make({ code }) })

const ended = (cause: SessionEnded["cause"], resync: boolean) =>
  ActorError.make({ reason: SessionEnded.make({ cause, resync }) })

/**
 * Owns stream admission, producer lifetime, bounded delivery and revocation.
 * The connection owner supplies the committed read context only after access
 * and capacity are checked; it retains generation acquisition and the ordered
 * broadcast channel. Streams have no durable session rows or replay promise.
 */
export const streamSubscriptions = ({
  registration,
  activations,
  transport,
  authorize,
  now,
  prepare,
}: {
  readonly registration: Registration
  readonly activations: ReadonlyMap<string, Activation>
  readonly transport: Pick<Transport, "holder" | "epoch">
  readonly authorize: Authorize
  readonly now: Effect.Effect<number>
  readonly prepare: (
    activation: Activation,
  ) => Effect.Effect<Omit<StreamInput, "caller">, ActorError, SqlClient.SqlClient>
}) => {
  /** Natural completion follows all elements; every other end is an explicit error. */
  const subscribe = (
    activation: Activation,
    request: {
      readonly member: string
      readonly caller: Caller
      readonly input: string
      readonly authorizedUntil: number
    },
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stream = registration.streams.get(request.member)

        if (stream === undefined)
          return yield* Effect.die(new Error(`Unregistered stream ${request.member}`))

        if ((yield* now) >= request.authorizedUntil)
          return yield* unauthorized("reauthorization_unavailable")

        const allowed = yield* authorize({
          caller: request.caller,
          ref: activation.ref,
          command: request.member,
          kind: "stream",
        })

        if (!allowed) return yield* unauthorized("access_denied")

        const queue = yield* Queue.bounded<
          StreamItem,
          ActorError | typeof StreamFailed.Type | Cause.Done
        >(STREAM_WINDOW)

        let producer: Fiber.Fiber<void> | undefined
        let closed = false

        const subscription: Subscription = {
          member: request.member,
          caller: request.caller,
          lastAuthorized: yield* now,
          checking: false,
          stalledSince: undefined,
          end: (error, discard) =>
            Effect.gen(function* () {
              if (closed) return
              closed = true
              activation.streams.delete(subscription)

              if (producer !== undefined) yield* Fiber.interrupt(producer)

              if (discard) yield* Queue.clear(queue).pipe(Effect.ignore)
              yield* Queue.fail(queue, error)
            }),
        }

        const admitted = yield* Effect.sync(() => {
          if (activation.streams.size >= MAX_ACTOR_STREAMS) return false
          activation.streams.add(subscription)

          return true
        })

        if (!admitted) return yield* ActorError.make({ reason: RunnerAtCapacity.make({}) })

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closed = true
            activation.streams.delete(subscription)

            if (producer !== undefined) yield* Fiber.interrupt(producer)
          }),
        )

        const input = yield* prepare(activation)

        const offer = (item: StreamItem) =>
          Effect.gen(function* () {
            if (Queue.offerUnsafe(queue, item)) return
            subscription.stalledSince = yield* now
            yield* Queue.offer(queue, item)
            subscription.stalledSince = undefined
          })

        producer = yield* stream.run(request.input, { ...input, caller: request.caller }).pipe(
          Stream.provideService(ColdRead, activation.cache.cold),
          Stream.runForEach((value) => offer(StreamItem.cases.Element.make({ value }))),
          Effect.andThen(offer(StreamItem.cases.Done.make({}))),
          Effect.andThen(Queue.end(queue)),
          Effect.catch(({ failure }) => Queue.fail(queue, StreamFailed.make({ value: failure }))),
          Effect.catchDefect((cause) =>
            Effect.andThen(
              Effect.logError("Stream handler defect", Cause.die(cause)),
              Queue.fail(queue, ended("Defect", false)),
            ),
          ),
          Effect.asVoid,
          Effect.ensuring(
            Effect.sync(() => {
              closed = true
              activation.streams.delete(subscription)
            }),
          ),
          Effect.forkDetach,
        )

        return Stream.succeed(
          StreamItem.cases.Started.make({ owner: transport.holder, ownerEpoch: transport.epoch }),
        ).pipe(Stream.concat(Stream.fromQueue(queue)))
      }),
    )

  const end = (activation: Activation) =>
    Effect.forEach(
      [...activation.streams],
      (subscription) => subscription.end(ended("ActivationEnded", false), false),
      { discard: true },
    )

  const reauthorize = (activation: Activation, subscription: Subscription, at: number) =>
    Effect.gen(function* () {
      subscription.checking = true

      const every = registration.policy.reauthorizeMs

      const allowed = yield* authorize({
        caller: subscription.caller,
        ref: activation.ref,
        command: subscription.member,
        kind: "reauthorize",
        of: "stream",
      }).pipe(Effect.timeout(Math.min(10_000, every / 2)), Effect.exit)

      subscription.checking = false
      const bound = subscription.lastAuthorized + every

      if (Exit.isSuccess(allowed) && allowed.value && (yield* now) >= bound)
        yield* subscription.end(unauthorized("reauthorization_unavailable"), true)
      else if (Exit.isSuccess(allowed) && allowed.value) subscription.lastAuthorized = at
      else if (Exit.isSuccess(allowed)) yield* subscription.end(unauthorized("access_denied"), true)
    })

  /** Revocation discards undelivered elements, including while a check is in flight. */
  const watch = Effect.gen(function* () {
    const at = yield* now
    const every = registration.policy.reauthorizeMs

    for (const activation of activations.values())
      for (const subscription of activation.streams) {
        if (at >= subscription.lastAuthorized + every) {
          yield* subscription
            .end(unauthorized("reauthorization_unavailable"), true)
            .pipe(Effect.forkDetach)

          continue
        }

        if (
          subscription.stalledSince !== undefined &&
          at - subscription.stalledSince >= STREAM_STALL_MS
        ) {
          yield* subscription.end(ended("SlowConsumer", true), true).pipe(Effect.forkDetach)

          continue
        }

        if (
          !subscription.checking &&
          at >= subscription.lastAuthorized + every - Math.min(10_000, every / 2)
        )
          yield* reauthorize(activation, subscription, at).pipe(Effect.forkDetach)
      }
  }).pipe(Effect.repeat(Schedule.spaced(STREAM_TICK)), Effect.asVoid)

  return { subscribe, end, watch }
}
