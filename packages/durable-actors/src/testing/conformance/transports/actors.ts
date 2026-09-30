import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { Actor, User } from "../../../index.ts"
import { Unauthorized } from "../../../errors/actor.ts"
import { type Authenticated, bearerToken } from "../../../serve/auth.ts"

export class Said extends Actor.Event<Said>()("Said", { text: Schema.String }) {}

export class Hello extends Schema.TaggedClass<Hello>()("Hello", {
  name: Schema.String,
  resumed: Schema.Boolean,
}) {}

export class Say extends Schema.TaggedClass<Say>()("Say", { text: Schema.String }) {}

export class Banned extends Schema.TaggedError<Banned>()("Banned", { name: Schema.String }) {}

/** A member frame whose body looks like the holder's control message. */
export const ForgedResync = Schema.TaggedStruct("Resync", { after: Schema.String })

export const Chat = Actor.connection("Chat", {
  params: Schema.Struct({ name: Schema.String }),
  server: Schema.Union([Said, Hello]),
  client: Say,
  session: Schema.Struct({ name: Schema.String }),
  errors: [Banned],
})

const Blind = Actor.connection("Blind", { server: Said, stampCursor: false })

const Post = Actor.command("Post", { input: Schema.String })

export const Percent = Schema.Struct({ percent: Schema.Finite })

/** An effect whose executor reports how far it got, one step at a time. */
class Render extends Actor.effect<Render>()("Render", {
  input: { steps: Schema.Int },
  progress: Percent,
}) {}

const Start = Actor.command("Start", { input: Schema.Int })

/** Receives Render's progress on every open connection, and no member frames. */
const Watch = Actor.connection("Watch", {
  server: Said,
  progress: { effects: [Render], to: "all" },
})

/** The actor served over WebSocket; its short revocation bound keeps revocation cases fast. */
export const SocketRoom = Actor.make("SocketRoom", {
  key: Schema.String,
  events: [Said],
  effects: [Render],
  api: { Chat, Blind, Post, Start, Watch },
  policy: {
    reauthorizeEvery: "2 seconds",
    effects: { Render: { retry: { times: 0 }, progressEvery: "50 millis" } },
  },
})

const socketLayer = SocketRoom.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* (text: string) {
      const turn = yield* SocketRoom.Turn
      yield* turn.emit(Said.make({ text }))
      yield* turn.broadcast(Chat, Said.make({ text }))
      yield* turn.broadcast(Blind, Said.make({ text }))
    }),
    Chat: {
      open: Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
        const conn = yield* SocketRoom.Connection

        if (name === "mallory") return yield* Banned.make({ name })

        yield* conn.session.set({ name })
        yield* conn.send(Hello.make({ name, resumed: conn.resumed }))
      }),
      frame: Effect.fnUntraced(function* (frame: Say) {
        const conn = yield* SocketRoom.Connection
        const session = Option.getOrElse(yield* conn.session.get, () => ({ name: "" }))

        if (frame.text === "whoami")
          return yield* conn.send(Hello.make({ name: session.name, resumed: conn.resumed }))

        if (frame.text === "history") {
          for (const entry of yield* conn.events(Said, { after: undefined }).pipe(Effect.orDie))
            yield* conn.send(entry)

          return
        }

        yield* (yield* SocketRoom.get(conn.id)).Post(frame.text).pipe(Effect.orDie)
      }),
      resync: Effect.fnUntraced(function* ({ after }: { readonly after: string | undefined }) {
        const conn = yield* SocketRoom.Connection

        for (const entry of yield* conn.events(Said, { after }).pipe(Effect.orDie))
          yield* conn.send(entry)
      }),
    },
    Blind: { open: () => Effect.void, frame: () => Effect.void },
    Start: Effect.fnUntraced(function* (steps: number) {
      yield* (yield* SocketRoom.Turn).perform(Render.make({ steps }))
    }),
    Watch: { open: () => Effect.void, frame: () => Effect.void },
  }),
)

const renderLayer = SocketRoom.toEffectLayer(
  Effect.succeed({
    Render: Effect.fnUntraced(function* ({ steps }) {
      const exec = yield* SocketRoom.Executor

      for (let step = 1; step <= steps; step++) {
        yield* exec.progress(Render, { percent: (100 * step) / steps })
        yield* Effect.sleep("50 millis")
      }
    }),
  }),
)

class Noted extends Actor.Event<Noted>()("Noted", { text: Schema.String }) {}

const Tell = Actor.command("Tell", { input: Schema.String })

const Note = Actor.command("Note", { input: Schema.String })

const Burst = Actor.command("Burst", { input: Schema.Int })

export class Refused extends Schema.TaggedError<Refused>()("Refused", { at: Schema.Finite }) {}

/** `count` numbers, then its own end; a count over 100 is refused after the first element. */
const Count = Actor.stream("Count", {
  input: Schema.Finite,
  output: Schema.Finite,
  errors: [Refused],
})

/** Committed `Said` texts after `after`, then each new one as it commits. */
const Heard = Actor.stream("Heard", {
  input: Schema.Struct({ after: Schema.optional(Schema.String) }),
  output: Schema.String,
})

/** The actor served as an event feed: `Said` is served, `Noted` is declared but not a feed. */
export const FeedRoom = Actor.make("FeedRoom", {
  key: Schema.String,
  events: [Said, Noted],
  feeds: [Said],
  api: { Tell, Note, Burst, Count, Heard },
  policy: { reauthorizeEvery: "2 seconds" },
})

const feedLayer = FeedRoom.toLayer(
  Effect.succeed({
    Tell: Effect.fnUntraced(function* (text: string) {
      yield* (yield* FeedRoom.Turn).emit(Said.make({ text }))
    }),
    Note: Effect.fnUntraced(function* (text: string) {
      yield* (yield* FeedRoom.Turn).emit(Noted.make({ text }))
    }),
    Count: (count: number) =>
      count > 100
        ? Stream.concat(Stream.make(1), Stream.fail(Refused.make({ at: 1 })))
        : Stream.range(1, count),
    Heard: ({ after }: { readonly after?: string | undefined }) =>
      Stream.unwrap(
        Effect.map(FeedRoom.Read, (read) =>
          read.follow(Said, { after }).pipe(Stream.map((entry) => entry.event.text)),
        ),
      ).pipe(Stream.orDie),
    Burst: Effect.fnUntraced(function* (count: number) {
      const turn = yield* FeedRoom.Turn

      for (let index = 0; index < count; index++)
        yield* turn.emit(Said.make({ text: `burst-${index}` }))
    }),
  }),
)

/**
 * `tenant:subject`, or `tenant:subject:expiresAtMs` for a credential with an
 * expiry, which the holder enforces on its own clock; `expired` is refused.
 * Read from `hello`, `reauthenticate`, or the upgrade's `authorization`.
 */
export const tokens = Actor.auth.make((request) =>
  Effect.gen(function* () {
    const token = yield* bearerToken(request)

    if (token === "expired") return yield* Unauthorized.make({ code: "expired" })

    const match = /^([^:]+):([^:]+)(?::(\d+))?$/.exec(token)

    if (match === null) return yield* Unauthorized.make({ code: "invalid_credentials" })

    const authenticated: Authenticated = {
      tenant: match[1]!,
      caller: User.make({ subject: match[2]! }),
    }

    return match[3] === undefined
      ? authenticated
      : { ...authenticated, expiresAt: DateTime.makeUnsafe(Number(match[3])) }
  }),
)

export const transportsLayer = Layer.mergeAll(socketLayer, renderLayer, feedLayer)
