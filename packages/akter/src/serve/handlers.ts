import { Cause, Effect, JsonPatch, Queue, Schema, Stream } from "effect"
import type { Rpc, RpcGroup } from "effect/rpc"
import type { Fields } from "../contract/context.ts"
import { ActorError, SessionEnded } from "../contract/errors.ts"
import type { RangeOptions } from "../contract/members.ts"
import type { ByValue, StateFrame } from "../contract/handle.ts"
import type { AnyActor } from "../contract/make.ts"
import { isList } from "../contract/members.ts"
import type { Action } from "../contract/members.ts"
import type { Engine } from "../execution/engine.ts"
import { Transports } from "../execution/transport.ts"
import {
  ActionFailed,
  ActionPayload,
  FindCodec,
  FindPayload,
  type Frame,
  type GroupRpc,
  JoinPayload,
  RangePayload,
  ReauthenticatePayload,
  Tags,
  TargetPayload,
  ViewPayload,
} from "../rpc/group.ts"
import { type Authorization, CurrentSession, Sessions } from "./session.ts"
import type { Session } from "./session.ts"

/**
 * How many values a stream holds for a consumer that falls behind. A state, list or view stream
 * keeps the newest values and diffs from the last one it sent, so a lagging consumer receives
 * one patch to the current value instead of every intermediate one; an event stream cannot
 * merge values, so it ends with `SessionEnded { cause: "SlowConsumer", resync: true }`.
 */
export const STREAM_BUFFER = 64

/** A handler of any call of the group. */
type Handler = RpcGroup.HandlersFrom<Rpc.AddMiddleware<GroupRpc, typeof Authorization>>[string]

interface Versioned {
  readonly version: number
  readonly value: Schema.Json
}

/** Full values to wire frames: the first value whole, then a JSON patch per changed value. */
const framed = <E, R>(values: Stream.Stream<Versioned, E, R>): Stream.Stream<Frame, E, R> =>
  values.pipe(
    Stream.buffer({ capacity: STREAM_BUFFER, strategy: "sliding" }),
    Stream.mapAccum(
      (): Schema.Json | undefined => undefined,
      (last, { version, value }): readonly [Schema.Json, ReadonlyArray<Frame>] => {
        if (last === undefined) return [value, [{ kind: "Frame", version, value }]]
        const ops = JsonPatch.get(last, value)
        return [value, ops.length === 0 ? [] : [{ kind: "Patch", version, ops }]]
      },
    ),
  )

/** Numbers successive values, for streams whose source has no version of its own. */
const numbered = <E, R>(values: Stream.Stream<Schema.Json, E, R>) =>
  values.pipe(
    Stream.mapAccum(
      () => 0,
      (count, value): readonly [number, ReadonlyArray<Versioned>] => [
        count + 1,
        [{ version: count + 1, value }],
      ],
    ),
  )

/** State frames back to full values, so they can share the lagging-consumer buffer. */
const values = <E, R>(frames: Stream.Stream<StateFrame, E, R>) =>
  frames.pipe(
    Stream.mapAccum(
      (): Schema.Json => null,
      (current, frame): readonly [Schema.Json, ReadonlyArray<Versioned>] => {
        const value = frame.kind === "Frame" ? frame.value : JsonPatch.apply(frame.ops, current)
        return [value, [{ version: frame.version, value }]]
      },
    ),
  )

const slowConsumer = ActorError.make({
  reason: SessionEnded.make({ cause: "SlowConsumer", resync: true }),
})

/** Events through a bounded queue: a consumer that lets it fill loses the stream, never an event silently. */
const bounded = <R>(events: Stream.Stream<Schema.Json, ActorError, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.dropping<Schema.Json, ActorError | Cause.Done>(STREAM_BUFFER)
      yield* events.pipe(
        Stream.runForEach((event) =>
          Effect.flatMap(Queue.offer(queue, event), (accepted) =>
            accepted ? Effect.void : Effect.asVoid(Queue.fail(queue, slowConsumer)),
          ),
        ),
        Effect.matchCauseEffect({
          onSuccess: () => Queue.end(queue),
          onFailure: (cause) => Queue.failCause(queue, cause),
        }),
        Effect.forkScoped,
      )
      return Stream.fromQueue(queue)
    }),
  )

const rangeOf = (payload: typeof RangePayload.Type): RangeOptions<ByValue> => ({
  from: payload.from,
  to: payload.to,
  limit: payload.limit,
  reverse: payload.reverse,
})

/** Records that the session called `actor`, so its reauthorization asks `access` about it again. */
const touched = (session: Session, actor: AnyActor) =>
  Effect.sync(() => {
    session.actors.add(actor)
  })

/** A one-shot call in its session: the caller is the session's, and the call ends with it. */
const call = <A, E>(
  actor: AnyActor,
  run: (session: Session) => Effect.Effect<A, E>,
): Effect.Effect<A, E | ActorError, CurrentSession> =>
  Effect.flatMap(CurrentSession, (session) =>
    Sessions.guard(
      session,
      Effect.tap(run(session), () => touched(session, actor)),
    ),
  )

/** A stream in its session, ended with the session's error when the session ends. */
const stream = <A, E>(
  actor: AnyActor,
  run: (session: Session) => Stream.Stream<A, E>,
): Stream.Stream<A, E | ActorError, CurrentSession> =>
  Stream.unwrap(
    Effect.map(CurrentSession, (session) =>
      Sessions.guardStream(session, run(session).pipe(Stream.tap(() => touched(session, actor)))),
    ),
  )

/** The handlers of one actor's calls, keyed by tag, over the engine. */
const actorHandlers = (engine: Engine, actor: AnyActor) => {
  const name = actor.name
  const reads = (session: Session) => Transports.reads(engine, session.caller)
  const handlers = new Map<string, Handler>()
  handlers.set(Tags.state(name), (payload: typeof TargetPayload.Type) =>
    stream(actor, (session) =>
      reads(session).state({ actor, id: payload.id }).pipe(values, framed),
    ),
  )
  handlers.set(Tags.find(name), (payload: typeof FindPayload.Type) =>
    call(actor, (session) =>
      Effect.flatMap(FindCodec.decode(actor, payload), (query) =>
        reads(session).find({ actor, query }),
      ),
    ),
  )
  const actions: Record<string, Action> = actor.actions
  for (const [member, declaration] of Object.entries(actions)) {
    if (declaration.internal) continue
    handlers.set(Tags.action(name, member), (payload: typeof ActionPayload.Type) =>
      call(actor, (session) =>
        Effect.flatMap(
          Transports.admitted(engine, session.caller, payload.commandId, {
            actor,
            id: payload.id,
            member,
            payload: payload.payload,
          }),
          ({ reply, replayed }) =>
            reply.kind === "Success"
              ? Effect.succeed({ value: reply.value, replayed })
              : Effect.fail(ActionFailed.make({ error: reply.error, replayed })),
        ),
      ),
    )
  }
  const fields: Fields = actor.state.fields
  for (const [member, field] of Object.entries(fields)) {
    if (!isList(field)) continue
    handlers.set(Tags.range(name, member), (payload: typeof RangePayload.Type) =>
      call(actor, (session) =>
        reads(session).range({ actor, id: payload.id, member, range: rangeOf(payload) }),
      ),
    )
    handlers.set(Tags.watch(name, member), (payload: typeof RangePayload.Type) =>
      stream(actor, (session) =>
        reads(session)
          .watch({ actor, id: payload.id, member, range: rangeOf(payload) })
          .pipe(
            Stream.map((items): Schema.Json => items),
            numbered,
            framed,
          ),
      ),
    )
  }
  for (const member of Object.keys(actor.views))
    handlers.set(Tags.view(name, member), (payload: typeof ViewPayload.Type) =>
      stream(actor, (session) =>
        reads(session)
          .view({ actor, id: payload.id, member, params: payload.params })
          .pipe(numbered, framed),
      ),
    )
  for (const member of Object.keys(actor.events))
    handlers.set(Tags.event(name, member), (payload: typeof TargetPayload.Type) =>
      stream(actor, (session) =>
        bounded(reads(session).event({ actor, id: payload.id, member, params: null })),
      ),
    )
  if (actor.presence !== undefined)
    handlers.set(Tags.join(name), (payload: typeof JoinPayload.Type) =>
      stream(actor, (session) =>
        Stream.unwrap(
          Effect.as(
            reads(session).join({ actor, id: payload.id, presence: payload.presence }),
            Stream.concat(Stream.make("joined" as const), Stream.never),
          ),
        ),
      ),
    )
  return handlers
}

/** Every handler of the group derived from `actors`, keyed by tag. */
const make = (engine: Engine, actors: ReadonlyArray<AnyActor>, sessions: Sessions) => {
  const handlers = new Map<string, Handler>()
  handlers.set(Tags.reauthenticate, (payload: typeof ReauthenticatePayload.Type) =>
    Effect.flatMap(CurrentSession, (session) =>
      sessions.reauthenticate(session, payload.authorization),
    ),
  )
  for (const actor of actors)
    for (const [tag, handler] of actorHandlers(engine, actor)) handlers.set(tag, handler)
  return Object.fromEntries(handlers)
}

/** The `/rpc` handlers over an engine. */
export const Handlers = { make }
