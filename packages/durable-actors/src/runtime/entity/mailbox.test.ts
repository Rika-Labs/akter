import { describe, expect, it } from "vitest"
import type { Request } from "../../handles/actors.ts"
import { BATCH_CAP, MERGE_CAP, takeBatch } from "./mailbox.ts"

const waiting = (ids: ReadonlyArray<string>) =>
  ids.map((commandId) => ({ request: { commandId, command: "Add" } as Request, command: {} }))

const idsOf = (batch: ReadonlyArray<{ readonly request: Request }>) =>
  batch.map(({ request }) => request.commandId)

describe("takeBatch", () => {
  it("takes every waiting command in delivery order, up to the cap", () => {
    const queue = waiting(Array.from({ length: BATCH_CAP + 3 }, (_, index) => `c${index}`))
    const first = takeBatch({ waiting: queue, alone: new Set() })

    expect(idsOf(first)).toEqual(Array.from({ length: BATCH_CAP }, (_, index) => `c${index}`))
    expect(idsOf(queue)).toEqual([`c${BATCH_CAP}`, `c${BATCH_CAP + 1}`, `c${BATCH_CAP + 2}`])
  })

  it("stops before a command id the batch already holds", () => {
    const queue = waiting(["a", "b", "a", "c"])

    expect(idsOf(takeBatch({ waiting: queue, alone: new Set() }))).toEqual(["a", "b"])
    expect(idsOf(takeBatch({ waiting: queue, alone: new Set() }))).toEqual(["a", "c"])
  })

  it("runs each command of a failed batch alone, once", () => {
    const queue = waiting(["a", "b", "c", "d"])
    const alone = new Set(["b", "c"])

    expect(idsOf(takeBatch({ waiting: queue, alone }))).toEqual(["a"])
    expect(idsOf(takeBatch({ waiting: queue, alone }))).toEqual(["b"])
    expect(idsOf(takeBatch({ waiting: queue, alone }))).toEqual(["c"])
    expect(idsOf(takeBatch({ waiting: queue, alone }))).toEqual(["d"])
    expect(alone.size).toBe(0)
  })

  it("takes nothing from an empty mailbox", () => {
    expect(takeBatch({ waiting: [], alone: new Set() })).toEqual([])
  })
})

describe("takeBatch with commutative calls", () => {
  const call = (commandId: string, command: string, commutative: boolean) => ({
    request: { commandId, command } as Request,
    command: commutative ? { merge: () => undefined } : {},
  })

  it("counts consecutive calls of one commutative reducer as one turn, up to the merge cap", () => {
    const queue = [
      ...Array.from({ length: MERGE_CAP + 1 }, (_, index) => call(`t${index}`, "Tick", true)),
      ...Array.from({ length: BATCH_CAP }, (_, index) => call(`a${index}`, "Add", false)),
    ]

    const batch = takeBatch({ waiting: queue, alone: new Set() })

    // One merged turn of 1,024, one of the 1 left over, then 30 more turns.
    expect(batch).toHaveLength(MERGE_CAP + 1 + BATCH_CAP - 2)
    expect(idsOf(queue)).toEqual(["a30", "a31"])
  })

  it("merges only neighbours: another command between two calls starts a new turn", () => {
    const queue = [call("t1", "Tick", true), call("x", "Add", false), call("t2", "Tick", true)]

    expect(idsOf(takeBatch({ waiting: queue, alone: new Set() }))).toEqual(["t1", "x", "t2"])
  })
})
