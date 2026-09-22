import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CommandId, commandTimes } from "./command.ts"
import { Anonymous, callerKey, User } from "./caller.ts"

describe("command identity", () => {
  const id = "v1.1000.6000.17b3670b-3f17-4a9b-aade-037e1dd1bba8"
  it("binds both times into one canonical identity", () => {
    expect(commandTimes(id)).toEqual({ issuedAt: 1000, expiresAt: 6000 })

    for (const invalid of [
      id.replace("v1", "v2"),
      id.replace("1000", "01000"),
      `${id}.extra`,
      id.toUpperCase(),
    ]) {
      expect(Schema.is(CommandId)(invalid)).toBe(false)
    }
  })
  it("uses logical subjects, not credentials or ambiguous string concatenation", () => {
    expect(callerKey(User.make({ subject: "alice" }))).toBe(
      callerKey(User.make({ subject: "alice" })),
    )
    expect(callerKey(User.make({ subject: "Anonymous" }))).not.toBe(callerKey(Anonymous.make({})))
    expect(callerKey(User.make({ subject: "alice" }))).not.toBe(
      callerKey(User.make({ subject: "bob" })),
    )
  })
})
