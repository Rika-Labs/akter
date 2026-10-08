import type {
  NodeInspectSymbol,
  Unify,
} from "../../../../../packages/akter/src/actor/definition.ts"
import { DateTime, Deferred, Duration, Effect, Option, Predicate, Schema } from "effect"
import { Actor, Intent } from "../../../../../packages/akter/src/index.ts"
import { CurrentCaller, Tenant } from "../../../../../packages/akter/src/identity/caller.ts"
import type { ConformanceSuite } from "../../conformance.ts"

export const Said = Actor.event("Said", { text: Schema.String })

export class Hello extends Schema.TaggedClass<Hello>()("Hello", {
  name: Schema.String,
  resumed: Schema.Boolean,
  frames: Schema.Finite,
}) {}

export class Say extends Schema.TaggedClass<Say>()("Say", { text: Schema.String }) {}

/** A server frame with an event entry's shape whose `event` is no server frame. */
class Receipted extends Schema.TaggedClass<Receipted>()("Receipted", {
  cursor: Schema.String,
  event: Schema.String,
  commandId: Schema.String,
  timestamp: Schema.DateTimeUtc,
}) {}

export const receipted = Receipted.make({
  cursor: "7",
  event: "not a frame",
  commandId: "command",
  timestamp: DateTime.makeUnsafe(0),
})

export class Banned extends Schema.TaggedError<Banned>()("Banned", { name: Schema.String }) {}

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const LiveSession = Schema.Struct({ name: Schema.String, frames: Schema.Finite })

/** A session's own encoded JSON, which the 16 KiB limit measures. */
export const sessionJson = (session: typeof LiveSession.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(LiveSession))(session).pipe(Effect.orDie)

/** A stored session: its encoded JSON inside the codec's `value` envelope. */
export const storedSession = (stored: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ value: LiveSession })))(stored).pipe(
    Effect.orDie,
  )

export const Live = Actor.connection("Live", {
  payload: Schema.Struct({ name: Schema.String }),
  server: Schema.Union([Said, Hello, Receipted]),
  client: Say,
  session: LiveSession,
  error: Banned,
})

/** A connection member `LiveRoom` does not declare. */
export const Undeclared = Actor.connection("Undeclared", {
  payload: Schema.Struct({}),
  server: Said,
  client: Say,
})

const Post = Actor.command("Post", { payload: Schema.String, error: Refused })

/** Stages `Post(text)` to the room `to`, or to itself, as an intent delayed by `afterMs` when given. */
const Forward = Actor.command("Forward", {
  payload: Schema.Struct({
    to: Schema.optional(Schema.String),
    text: Schema.String,
    afterMs: Schema.optional(Schema.Int),
  }),
})

/** Performs `Echo`, whose success routes back to the room as `Echoed`. */
const Shout = Actor.command("Shout", { payload: Schema.String })

const Echoed = Actor.command("Echoed", { payload: Schema.String })

const Echo = Actor.job("LiveEcho", {
  payload: { text: Schema.String },
  success: Schema.String,
})

export const Room = Actor.make("LiveRoom", {
  key: Schema.String,
  state: Actor.state({ posts: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  events: [Said],
  jobs: { LiveEcho: { job: Echo, onSuccess: Echoed } },
  api: { Live, Post, Forward, Shout },
  internal: { Echoed },
})

/** Frames a `flood` sends in one handler, past the 1,024-frame outbound limit. */
const FLOOD = 1_100

/** Controls the connection cases share with the room's handlers; a case restores what it changes. */
export interface ConnectionsFixture {
  /** Where an open for `held` or a `hold` frame waits, once; it then resets to nothing. */
  hold: Effect.Effect<void>
  /** What the `Echo` executor does before it succeeds. */
  echo: Effect.Effect<void>
}

export const connectionsFixture = (): ConnectionsFixture => ({
  hold: Effect.void,
  echo: Effect.void,
})

const takeHold = (fixture: ConnectionsFixture) =>
  Effect.suspend(() => {
    const hold = fixture.hold
    fixture.hold = Effect.void

    return hold
  })

/** Makes the next handler that reaches `hold` wait until the case releases it. */
export const holdNext = (fixture: ConnectionsFixture) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    fixture.hold = Deferred.succeed(reached, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    )

    return {
      reached: Deferred.await(reached),
      release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
    }
  })

const said = Effect.fnUntraced(function* (text: string) {
  const turn = yield* Room.Turn
  yield* turn.emit(Said.make({ text }))
  yield* turn.broadcast(Live, Said.make({ text }))
})

export const connectionsLayer = (fixture: ConnectionsFixture) =>
  Room.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* (text: string) {
        const turn = yield* Room.Turn
        yield* said(text)

        if (text === "refuse") return yield* Refused.make({})

        yield* turn.state.set({ posts: turn.state.posts + 1 })
      }),
      Forward: Effect.fnUntraced(function* ({ to, text, afterMs }) {
        const turn = yield* Room.Turn
        const intent = (yield* Room.intents(to ?? turn.id)).Post(text)

        yield* afterMs === undefined ? intent : intent.pipe(Intent.after(Duration.millis(afterMs)))
      }),
      Shout: Effect.fnUntraced(function* (text: string) {
        const turn = yield* Room.Turn
        yield* turn.enqueue(Echo.make({ text }))
      }),
      Echoed: said,
      Live: {
        open: Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
          const conn = yield* Room.Connection

          if (name === "mallory") return yield* Banned.make({ name })

          if (name === "leaver") return yield* conn.close

          if (name === "held") yield* takeHold(fixture)

          yield* conn.session.set({ name, frames: 0 })
          yield* conn.send(Hello.make({ name, resumed: conn.resumed, frames: 0 }))
        }),
        frame: Effect.fnUntraced(function* (frame: Say) {
          const conn = yield* Room.Connection
          const session = Option.getOrElse(yield* conn.session.get, () => ({ name: "", frames: 0 }))
          const frames = session.frames + 1
          yield* conn.session.set({ frames })

          if (frame.text === "hold") {
            yield* takeHold(fixture)

            return yield* conn.send(
              Hello.make({ name: session.name, resumed: conn.resumed, frames }),
            )
          }

          if (frame.text === "leave") return yield* conn.close

          if (frame.text === "receipted") return yield* conn.send(receipted)

          if (frame.text.startsWith("grow:")) {
            const length = Number(frame.text.slice("grow:".length))
            yield* conn.session.set({ name: "x".repeat(length), frames })

            return yield* conn.send(
              Hello.make({ name: `${length}`, resumed: conn.resumed, frames }),
            )
          }

          if (frame.text === "whoami")
            return yield* conn.send(
              Hello.make({ name: session.name, resumed: conn.resumed, frames }),
            )

          if (frame.text === "caller") {
            const caller = yield* CurrentCaller
            const subject = Predicate.isTagged(caller, "User") ? caller.subject : ""
            const tenant = yield* Tenant

            return yield* conn.send(
              Hello.make({
                name: `${tenant}/${caller._tag}/${subject}`,
                resumed: conn.resumed,
                frames,
              }),
            )
          }

          if (frame.text === "flood") {
            for (let index = 0; index < FLOOD; index++)
              yield* conn.send(Hello.make({ name: session.name, resumed: conn.resumed, frames }))

            return
          }

          yield* (yield* Room.get(conn.id)).Post(frame.text).pipe(Effect.orDie)
        }),
        resync: Effect.fnUntraced(function* ({ after }: { readonly after: string | undefined }) {
          const conn = yield* Room.Connection
          const session = yield* conn.session.get

          if (Option.isSome(session) && session.value.name === "quitter") return yield* conn.close

          for (const entry of yield* conn.events(Said, { after }).pipe(Effect.orDie))
            yield* conn.send(entry)
        }),
      },
    }),
  )

export type { NodeInspectSymbol, Unify }

/** The connection room. */
export const connectionsSuite: ConformanceSuite<ConnectionsFixture> = {
  fixture: connectionsFixture,
  layer: connectionsLayer,
}
