import { describe, expect, it } from "vitest"
import { Effect, Fiber } from "effect"
import type { Request } from "../request.ts"
import {
  activationMailbox,
  ALONE_CAP,
  BATCH_CAP,
  markAlone,
  MERGE_CAP,
  takeBatch,
} from "./mailbox.ts"

const waiting = (ids: ReadonlyArray<string>) =>
  ids.map((commandId) => ({
    request: { commandId, command: "Add" } as Request,
    command: {},
    queued: true,
  }))

const idsOf = (batch: ReadonlyArray<{ readonly request: Request }>) =>
  batch.map(({ request }) => request.commandId)

describe("activationMailbox", () => {
  it("keeps waiting commands and retry isolation local while requeue preserves delivery order", () => {
    const first = activationMailbox(new Set<string>())
    const second = activationMailbox(new Set<string>())
    const [a, b, c] = waiting(["a", "b", "c"])

    first.offer(a!)
    first.offer(b!)
    second.offer(c!)
    first.isolate(["b"])

    expect(idsOf(first.take())).toEqual(["a"])
    expect(first.size()).toBe(1)
    expect(second.size()).toBe(1)
    first.requeue([a!])
    expect(idsOf(first.take())).toEqual(["a"])
    expect(idsOf(first.take())).toEqual(["b"])
    expect(idsOf(second.take())).toEqual(["c"])
    expect(first.size()).toBe(0)
    expect(second.size()).toBe(0)
  })

  it("wakes only its own worker after queued finishes and closes again after taking work", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = activationMailbox(new Set<string>())
        const second = activationMailbox(new Set<string>())
        const [a, b] = waiting(["a", "b"])
        a!.queued = false
        b!.queued = false
        first.offer(a!)
        second.offer(b!)
        const worker = yield* Effect.forkChild(first.await)
        yield* Effect.yieldNow

        second.queued(b!)
        yield* Effect.yieldNow
        expect(worker.pollUnsafe()).toBeUndefined()
        expect(first.take()).toEqual([])

        first.queued(a!)
        yield* Fiber.join(worker)
        expect(idsOf(first.take())).toEqual(["a"])
        const next = yield* Effect.forkChild(first.await)
        yield* Effect.yieldNow
        expect(next.pollUnsafe()).toBeUndefined()
      }).pipe(Effect.scoped, Effect.timeout("1 second")),
    ))
})

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

  it("keeps at most the newest ALONE_CAP ids to run alone, however many callers never retry", () => {
    const alone = new Set<string>()

    for (let failed = 0; failed < 3; failed++)
      markAlone({
        alone,
        ids: Array.from({ length: ALONE_CAP }, (_, index) => `f${failed}-${index}`),
      })

    expect(alone.size).toBe(ALONE_CAP)
    expect(alone.has(`f2-0`)).toBe(true)
    expect(alone.has(`f1-${ALONE_CAP - 1}`)).toBe(false)

    markAlone({ alone, ids: ["f2-0", "late"] })

    expect(alone.size).toBe(ALONE_CAP)
    expect([...alone].at(-1)).toBe("late")
    expect(alone.has("f2-0")).toBe(true)
    expect(alone.has("f2-1")).toBe(false)
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

describe("takeBatch with commutative calls", () => {
  const call = (commandId: string, command: string, commutative: boolean) => ({
    request: { commandId, command } as Request,
    command: commutative ? { merge: () => undefined } : {},
    queued: true,
  })

  it("counts consecutive calls of one commutative reducer as one turn, up to the merge cap", () => {
    const queue = [
      ...Array.from({ length: MERGE_CAP + 1 }, (_, index) => call(`t${index}`, "Tick", true)),
      ...Array.from({ length: BATCH_CAP }, (_, index) => call(`a${index}`, "Add", false)),
    ]

    const batch = takeBatch({ waiting: queue, alone: new Set() })

    expect(batch).toHaveLength(MERGE_CAP + 1 + BATCH_CAP - 2)
    expect(idsOf(queue)).toEqual(["a30", "a31"])
  })

  it("merges only neighbours: another command between two calls starts a new turn", () => {
    const queue = [call("t1", "Tick", true), call("x", "Add", false), call("t2", "Tick", true)]

    expect(idsOf(takeBatch({ waiting: queue, alone: new Set() }))).toEqual(["t1", "x", "t2"])
  })
})
