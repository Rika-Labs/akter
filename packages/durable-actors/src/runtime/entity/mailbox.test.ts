import { describe, expect, it } from "vitest"
import type { Request } from "../../handles/actors.ts"
import { BATCH_CAP, takeBatch } from "./mailbox.ts"

const waiting = (ids: ReadonlyArray<string>) =>
  ids.map((commandId) => ({ request: { commandId } as Request, queued: true }))

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

  it("stops at the first command whose queued hook has not finished", () => {
    const queue = waiting(["a", "b", "c", "d"])
    queue[2]!.queued = false

    expect(idsOf(takeBatch({ waiting: queue, alone: new Set() }))).toEqual(["a", "b"])
    expect(idsOf(queue)).toEqual(["c", "d"])
  })

  it("takes nothing while the first command is still in its queued hook", () => {
    const queue = waiting(["a", "b"])
    queue[0]!.queued = false

    expect(takeBatch({ waiting: queue, alone: new Set() })).toEqual([])
    expect(idsOf(queue)).toEqual(["a", "b"])

    queue[0]!.queued = true

    expect(idsOf(takeBatch({ waiting: queue, alone: new Set() }))).toEqual(["a", "b"])
  })

  it("takes nothing from an empty mailbox", () => {
    expect(takeBatch({ waiting: [], alone: new Set() })).toEqual([])
  })
})
