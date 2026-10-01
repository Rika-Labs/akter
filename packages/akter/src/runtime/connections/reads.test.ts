import { describe, expect, it } from "vitest"
import { emptyReadSet, invalidates, unsupportedRead } from "./reads.ts"

const nothing = { state: false, events: [], tables: [], blobs: [] }

describe("watch read sets", () => {
  it("is invalidated only by a write to something the query read", () => {
    const reads = emptyReadSet()
    reads.events.add("Said")
    reads.tables.add("rows")

    expect(invalidates(nothing, reads)).toBe(false)
    expect(invalidates({ ...nothing, state: true }, reads)).toBe(false)
    expect(invalidates({ ...nothing, events: ["Other"] }, reads)).toBe(false)
    expect(invalidates({ ...nothing, blobs: ["rows"] }, reads)).toBe(false)
    expect(invalidates({ ...nothing, events: ["Other", "Said"] }, reads)).toBe(true)
    expect(invalidates({ ...nothing, tables: ["rows"] }, reads)).toBe(true)
  })

  it("counts any state write as a write of all state, and a blob write against blobs", () => {
    const state = emptyReadSet()
    state.state = true

    const blobs = emptyReadSet()
    blobs.blobs.add("files")

    expect(invalidates({ ...nothing, state: true }, state)).toBe(true)
    expect(invalidates({ ...nothing, state: true }, blobs)).toBe(false)
    expect(invalidates({ ...nothing, blobs: ["files"] }, blobs)).toBe(true)
  })

  it("names a group read as unsupported and no other read", () => {
    const reads = emptyReadSet()
    reads.state = true
    reads.caller = true

    expect(unsupportedRead(reads)).toBe(undefined)

    reads.group = true

    expect(unsupportedRead(reads)).toContain("placement group")
  })
})
