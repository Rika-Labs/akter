// Contract file: a user actor that owns a workflow (decision 158). The workflow is a member, its body lives in User.server.ts.
import { Effect, Schema } from "effect"
import { Actor, Events, Hibernate } from "../framework/Actor.ts"
import { NotAMember, RoomId } from "./Chat.ts"
import { UserId } from "./Principal.ts"

export class Joined extends Schema.TaggedClass<Joined>()("Joined", { roomId: RoomId }) {}
export class FirstMessage extends Schema.TaggedClass<FirstMessage>()("FirstMessage", { roomId: RoomId, messageId: Schema.String }) {}

export const Join = Actor.command("Join", {
  description: "Join a room and start onboarding for it. Joining the same room twice joins the running onboarding.",
  input: { roomId: RoomId }
})
// internal: Chat sends it as a durable intent when this user posts (Chat.server.ts)
export const NoteMessage = Actor.command("NoteMessage", {
  description: "Internal: the user posted a message in a room. Emits FirstMessage the first time per room.",
  input: { roomId: RoomId, messageId: Schema.String }
})

/** A durable execution owned by `User`: one run per (user, room) via `key: roomId`. */
export const Onboard = Actor.workflow("Onboard", {
  description: "Welcome the user in a room, wait a day for their first message, nudge them by email otherwise.",
  input: { roomId: RoomId },
  output: Schema.Struct({ nudged: Schema.Boolean }),
  errors: [NotAMember]
})

export const User = Actor.make("User", {
  description: "One actor per user: room memberships, first-message tracking, and the onboarding workflow.",
  id: UserId,
  commands: [Join, NoteMessage],
  internal: [NoteMessage],
  workflows: [Onboard],
  events: [Joined, FirstMessage],
  state: {
    // room id → whether the first message has been seen
    rooms: Schema.Record(RoomId, Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed({})))
  },
  lifecycle: [Hibernate.after("1 minute"), Events.keep("forever")]
})
