// Client side: one yield to get the actor, then plain Effects. The caller is ambient for the program.
import { Effect, Stream } from "effect"
import type { ActorUnavailable } from "../framework/Actor.ts"
import { Actor, Actors, Caller, TenantId } from "../framework/Actor.ts"
import type { Message, NotAMember } from "./Chat.ts"
import { Chat, RoomId, Typing } from "./Chat.ts"
import { CountChanged, Counter, CounterId } from "./Counter.ts"
import { Onboard } from "./Onboard.ts"
import { OrgId, UserId } from "./Principal.ts"

const alice = { userId: UserId.make("u1"), orgId: OrgId.make("acme"), roles: ["member"] as const }
const admin = { userId: UserId.make("u2"), orgId: OrgId.make("acme"), roles: ["admin"] as const }
const httpIdempotencyKey = "idempotency-key-from-http"

export const program = Effect.gen(function*() {
  const room = yield* Chat.get(RoomId.make("room-1")) // caller: ambient (see the pipe at the bottom)
  // E = InvalidMessage | NotAMember | CommandConflict | ActorUnavailable
  const msg = yield* room.SendMessage({ body: "hi" })
  // an externally supplied idempotency key, set ambiently for this call only
  yield* room.SendMessage({ body: "hi again" }).pipe(Actor.commandId(httpIdempotencyKey))
  const recent = yield* room.Recent({ limit: 20 }) // E = NotAMember: no cluster hop
  const live: Stream.Stream<Message, NotAMember | ActorUnavailable> = room.Transcript()

  // a connection is scoped: closing the scope closes the socket
  yield* Effect.scoped(Effect.gen(function*() {
    const conn = yield* room.Live({ since: 0 })
    yield* conn.send(new Typing({ userId: alice.userId }))
    yield* conn.frames.pipe(Stream.take(1), Stream.runDrain)
  }))

  // an explicit caller instead of the ambient one
  const pinned = yield* Chat.get(RoomId.make("room-1"), { as: admin })
  yield* pinned.SendMessage({ body: "pinned" })

  const run = yield* Onboard.start({ userId: alice.userId, roomId: RoomId.make("room-1") })
  const outcome = yield* run.result // Effect<{ nudged }, NotAMember | WorkflowInterrupted>

  // the non-sugared form of `Counter.get`, with the caller spelled out
  const actors = yield* Actors
  const counter = actors.get(Counter, CounterId.make("counter-123"), { as: Caller.user(alice) })
  const n = yield* counter.Increment(1)
  const total = yield* counter.GetCount()
  // the tenant is bound at `get`: `Actor.tenant` wraps the `get`, never a call on a handle
  const globex = yield* Counter.get(CounterId.make("counter-123")).pipe(Actor.tenant(TenantId.make("globex")))
  const other = yield* globex.GetCount()

  return { msg, recent, live, outcome, runId: run.id, n, total, other }
}).pipe(Actor.as(alice))

// typed event subscription with a cursor: replay from the beginning, then follow live
export const ticks = Effect.map(
  Counter.get(CounterId.make("counter-123")),
  (counter) => counter.events(CountChanged, { after: 0 })
)
