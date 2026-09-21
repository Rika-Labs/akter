// Contract file for a workflow: durable, resumable, idempotent on `userId`.
import { Schema } from "effect"
import { Actor } from "../framework/Actor.ts"
import { NotAMember, RoomId } from "./Chat.ts"
import { UserId } from "./Principal.ts"

export const Onboard = Actor.workflow("Onboard", {
  description: "Welcome a new user in their first room, wait a day for their first message, nudge them by email otherwise.",
  input: { userId: UserId, roomId: RoomId },
  output: Schema.Struct({ nudged: Schema.Boolean }),
  errors: [NotAMember],
  idempotencyKey: ({ userId }) => userId
})
