// Contract file for a workflow: durable, resumable, idempotent on `userId`.
import { Schema } from "effect"
import { Actor } from "../framework/Actor.ts"
import { NotAMember, RoomId } from "./Chat.ts"

export const Onboard = Actor.workflow("Onboard", {
  input: { userId: Schema.String, roomId: RoomId },
  output: Schema.Void,
  errors: [NotAMember],
  idempotencyKey: (input) => input.userId
})
