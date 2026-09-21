// Client side: one yield to get the actor, then plain Effects. The caller is ambient for the program.
import { Effect, Option, Stream } from "effect"
import type { ActorError } from "../framework/Actor.ts"
import { Actor, Actors, Caller, TenantId } from "../framework/Actor.ts"
import type { Message, NotAMember } from "./Chat.ts"
import { Chat, RoomId, Typing } from "./Chat.ts"
import { CodingAgent, Replied } from "./CodingAgent.ts"
import { CountChanged, Counter, CounterId } from "./Counter.ts"
import { OrgId, UserId } from "./Principal.ts"
import { User } from "./User.ts"

const alice = { userId: UserId.make("u1"), orgId: OrgId.make("acme"), roles: ["member"] as const }
const admin = { userId: UserId.make("u2"), orgId: OrgId.make("acme"), roles: ["admin"] as const }
const httpIdempotencyKey = "idempotency-key-from-http"

export const program = Effect.gen(function*() {
  const room = yield* Chat.get(RoomId.make("room-1")) // caller: ambient (see the pipe at the bottom)
  // E = InvalidMessage | NotAMember | ActorError (reasons: ActorUnavailable | MailboxFull | Timeout | CommandConflict)
  const msg = yield* room.SendMessage({ body: "hi" })
  // an externally supplied idempotency key, set ambiently for this call only
  yield* room.SendMessage({ body: "hi again" }).pipe(Actor.commandId(httpIdempotencyKey))
  const recent = yield* room.Recent({ limit: 20 }) // E = NotAMember: no cluster hop
  const live: Stream.Stream<Message, NotAMember | ActorError> = room.Transcript()

  // a connection is scoped: closing the scope closes the socket
  yield* Effect.scoped(Effect.gen(function*() {
    const conn = yield* room.Live({ since: 0 })
    yield* conn.send(new Typing({ userId: alice.userId }))
    yield* conn.frames.pipe(Stream.take(1), Stream.runDrain)
  }))

  // an explicit caller instead of the ambient one
  const pinned = yield* Chat.get(RoomId.make("room-1"), { as: admin })
  yield* pinned.SendMessage({ body: "pinned" })

  // a workflow is a member of its owner (decision 158): started on the handle, keyed per room
  const user = yield* User.get(alice.userId)
  yield* user.Join({ roomId: RoomId.make("room-1") }) // starts Onboard as an intent, committed with the turn
  const run = yield* user.Onboard.start({ roomId: RoomId.make("room-1") }, { key: "room-1" }) // joins the live run
  const outcome = yield* run.result // Effect<{ nudged }, NotAMember | WorkflowInterrupted>

  // delivery failures are one tagged error with a typed reason (decision 167): handle the reasons you care about
  const total = yield* room.SendMessage({ body: "retry me" }).pipe(
    Effect.catchReasons("ActorError", {
      MailboxFull: () => Effect.succeed(msg),
      Timeout: () => Effect.succeed(msg)
    })
  )

  // the non-sugared form of `Counter.get`, with the caller spelled out
  const actors = yield* Actors
  const counter = actors.get(Counter, CounterId.make("counter-123"), { as: Caller.user(alice) })
  const n = yield* counter.Increment(1)
  const count = yield* counter.GetCount()
  // the tenant is bound at `get`: `Actor.tenant` wraps the `get`, never a call on a handle
  const globex = yield* Counter.get(CounterId.make("counter-123")).pipe(Actor.tenant(TenantId.make("globex")))
  const other = yield* globex.GetCount()

  // minted ids (decision 164): `create()` returns a handle to a fresh UUIDv7; nothing is written until `Start`
  const agent = yield* CodingAgent.create()
  yield* agent.Start({ repo: "https://github.com/acme/app" })
  const turnId = yield* agent.Prompt({ text: "add a health endpoint" }) // E = TurnInProgress | ActorError
  const reply = yield* agent.events(Replied).pipe(
    Stream.filter((e) => e.event.turnId === turnId),
    Stream.runHead,
    Effect.map(Option.map((e) => e.event.text))
  )
  const ship = yield* agent.Ship.start({ task: "paginate the users list" }) // a second run under another key would be `{ key }`
  const shipped = yield* ship.result // Effect<{ turns, summary }, TurnFailed | WorkflowInterrupted>
  const transcript = yield* agent.Transcript({ limit: 10 })
  const later = yield* CodingAgent.get(agent.id) // the same actor, by its minted id

  return { msg, recent, live, outcome, runId: run.id, total, n, count, other, reply, shipped, transcript, later: later.id }
}).pipe(Actor.as(alice))

// typed event subscription with a cursor: replay from the beginning, then follow live
export const ticks = Effect.map(
  Counter.get(CounterId.make("counter-123")),
  (counter) => counter.events(CountChanged, { after: 0 })
)
