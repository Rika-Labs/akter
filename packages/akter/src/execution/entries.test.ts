import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { classify, Tags } from "../rpc/group.ts"
import { EntryCodec } from "./entries.ts"

const entry = (outcome: string, events: string) =>
  `{"_tag":"Action","commandId":"v1.1000.601000.0b0e8d5c-7d3f-4c1a-9f7e-3a2b1c0d9e8f","origin":{"_tag":"External","expiresAt":601000},"actor":"Room","key":"r1","member":"post","payload":"hello","digest":"d1","caller":{"_tag":"User","subject":"alice"},"at":1000,"effects":{"outcome":${outcome},"set":{"count":7},"unset":[],"lists":[],"sends":[],"timers":[],"starts":[],"events":${events},"ids":1,"randoms":0}}`

const encoder = new TextEncoder()

describe("stored and wire spellings", () => {
  it("decodes a 0.2 command entry and writes back the same bytes, so renaming a stored tag or field fails", () => {
    const stored = [
      entry(`{"_tag":"Success","value":3}`, `[{"event":"said","value":"hello"}]`),
      entry(
        `{"_tag":"Defect","kind":"SynchronousActionViolation","detail":"returned a promise"}`,
        `[]`,
      ),
    ]
    for (const text of stored) {
      const decoded = Result.getOrThrow(EntryCodec.decode(encoder.encode(text)))
      expect(new TextDecoder().decode(EntryCodec.encode(decoded))).toBe(text)
    }
    const renamed = stored[0]!.replace(`"_tag":"Action"`, `"_tag":"Command"`)
    expect(Result.isFailure(EntryCodec.decode(encoder.encode(renamed)))).toBe(true)
  })

  it("keeps the 0.2 call tags while the call class says command", () => {
    expect([Tags.action("Room", "post"), Tags.event("Room", "said")]).toEqual([
      "Room/post",
      "Room/$event:said",
    ])
    expect([classify("Room/post"), classify("Room/$event:said"), classify("Room/$join")]).toEqual([
      "command",
      "read",
      "presence",
    ])
  })
})
