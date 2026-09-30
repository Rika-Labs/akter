import { Deferred, Effect, Option, Schedule, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ActorError, InvalidInput, TransportError, Unauthorized } from "../../errors/actor.ts"
import type { Failure } from "../transport.ts"
import { type Delivery, type QueueOptions, type Refused, openCommandQueue } from "./queue.ts"
import { Offline, type OfflineStore, type QueuedCommand } from "./store.ts"

const NOW = 5_000

const UUID = "00000000-0000-4000-8000-000000000000"

const expiredId = `v1.1000.2000.${UUID}`

const liveId = (windowMs: number) => `v1.${NOW - 100}.${NOW - 100 + windowMs}.${UUID}`

const offline = ActorError.make({
  reason: TransportError.make({ code: "network", retryable: true }),
})

const rejected = ActorError.make({ reason: InvalidInput.make({ code: "decode" }) })

const signedOut = ActorError.make({ reason: Unauthorized.make({ code: "invalid_credentials" }) })

const refuse = (failure: Failure, retryAfterMs?: number, answer?: QueuedCommand["answer"]) =>
  Effect.fail<Refused>({
    failure,
    retryAfterMs: retryAfterMs === undefined ? Option.none() : Option.some(retryAfterMs),
    answer,
  })

type Attempt = Effect.Effect<string, Refused>

/**
 * A `begin` that answers each command from its own script, one entry per
 * attempt with the last repeating, and records every attempt's id.
 */
const scripted = (steps: Readonly<Record<string, ReadonlyArray<Attempt>>>) => {
  const attempts: Array<string> = []
  const taken = new Map<string, number>()

  const begin = (command: QueuedCommand): Attempt =>
    Effect.suspend(() => {
      attempts.push(command.commandId)

      const script = steps[command.commandId] ?? [Effect.succeed(`ok:${command.commandId}`)]
      const index = taken.get(command.commandId) ?? 0

      taken.set(command.commandId, index + 1)

      return script[Math.min(index, script.length - 1)]!
    })

  return { attempts, begin }
}

const failureOf = (command: QueuedCommand) =>
  ActorError.make({
    reason: TransportError.make({
      code: "status",
      status: command.answer?.status ?? 0,
      retryable: false,
    }),
  })

const fixture = (
  options: {
    readonly store?: OfflineStore
    readonly steps?: Readonly<Record<string, ReadonlyArray<Attempt>>>
    readonly actor?: string
    readonly baseUrl?: string
    readonly now?: () => number
    readonly principal?: () => string
  } = {},
) => {
  const store = options.store ?? Offline.memory()
  const script = scripted(options.steps ?? {})

  const queueOptions: QueueOptions<string> = {
    store,
    baseUrl: options.baseUrl ?? "/api",
    actor: options.actor ?? "Room",
    principal: Effect.sync(options.principal ?? (() => "alice")),
    now: options.now ?? (() => NOW),
    begin: script.begin,
    failureOf,
    warm: Effect.void,
  }

  const queue = openCommandQueue(queueOptions)

  return { store, queue, attempts: script.attempts }
}

type Queue = ReturnType<typeof fixture>["queue"]

const command = (commandId: string, target = "/actors/Room/r1", body = `{"text":"${commandId}"}`) =>
  Effect.succeed({ commandId, target, member: "Post", body })

const submit = (queue: Queue, commandId: string, target?: string, body?: string) =>
  Effect.promise(() => queue.submit(command(commandId, target, body), undefined)).pipe(
    Effect.map((delivery) => delivery as Delivery<string>),
  )

const until = (condition: () => boolean) =>
  Effect.suspend(() => (condition() ? Effect.void : Effect.fail("waiting"))).pipe(
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 600 }),
    Effect.orDie,
  )

const saved = (store: OfflineStore) =>
  Effect.promise(() => store.entries()).pipe(
    Effect.map((entries) => entries.map((entry) => `${entry.commandId}:${entry.status}`)),
  )

const reasonOf = (failure: Failure) => (Schema.is(ActorError)(failure) ? failure.reason : undefined)

const stored = (commandId: string, extra: Partial<QueuedCommand> = {}): QueuedCommand => ({
  commandId,
  sequence: 0,
  baseUrl: "/api",
  principal: "alice",
  target: "/actors/Room/r1",
  member: "Post",
  body: "{}",
  status: "queued",
  answer: undefined,
  ...extra,
})

const seed = (store: OfflineStore, ...commands: ReadonlyArray<QueuedCommand>) =>
  Effect.forEach(commands, (entry) => Effect.promise(() => store.save(entry)), { discard: true })

const gatedStore = (base: OfflineStore, gate: Deferred.Deferred<void>): OfflineStore => ({
  ...base,
  save: (entry) =>
    Effect.runPromise(
      Deferred.await(gate).pipe(Effect.andThen(Effect.promise(() => base.save(entry)))),
    ),
})

const controller = () => new AbortController()

afterEach(() => {
  vi.restoreAllMocks()
})

describe("offline command queue", () => {
  it("holds a command queued under another principal, never attempting it, and sends it once that principal is back", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let signedIn = "alice"

        const { queue, attempts, store } = fixture({
          principal: () => signedIn,
          steps: { a: [refuse(offline)] },
        })

        yield* Effect.promise(() => queue.ready)
        yield* submit(queue, "a")
        yield* until(() => attempts.length === 1)

        signedIn = "bob"
        queue.flush()
        yield* until(() => queue.pending[0]?.status === "held")
        yield* submit(queue, "b", "/actors/Room/r2")
        yield* until(() => queue.pending.length === 1)

        expect(attempts).toEqual(["a", "b"])
        expect(
          (yield* Effect.promise(() => store.entries())).map((entry) => entry.principal),
        ).toEqual(["alice"])

        signedIn = "alice"
        queue.flush()
        yield* until(() => queue.pending.length === 0 || attempts.length > 2)

        expect(attempts.slice(2)).toEqual(["a"])
        queue.close()
      }),
    ))

  it("sends nothing until the command is saved, then removes it once the server answers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = Deferred.makeUnsafe<void>()
        const base = Offline.memory()
        const { queue, attempts } = fixture({ store: gatedStore(base, gate) })
        const submitting = queue.submit(command("a"), undefined)

        yield* Effect.sleep("30 millis")
        expect(attempts).toEqual([])
        expect(queue.pending).toEqual([])

        yield* Deferred.succeed(gate, undefined)

        const delivery = (yield* Effect.promise(() => submitting)) as Delivery<string>

        expect(yield* delivery.settled).toBe("ok:a")
        expect(attempts).toEqual(["a"])
        expect(yield* saved(base)).toEqual([])
        expect(queue.pending).toEqual([])
      }),
    ))

  it("queues calls in the order they were made even when an earlier id takes longer to mint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, store, attempts } = fixture({
          steps: { a: [refuse(offline, 60_000)], b: [refuse(offline, 60_000)] },
        })

        const slow = Effect.sleep("40 millis").pipe(Effect.andThen(command("a")))
        const first = queue.submit(slow, undefined)
        const second = queue.submit(command("b"), undefined)

        yield* Effect.promise(() => Promise.all([first, second]))
        yield* until(() => attempts.length === 1)

        expect(attempts).toEqual(["a"])
        expect(queue.pending.map((pending) => pending.commandId)).toEqual(["a", "b"])
        expect(yield* saved(store)).toEqual(["a:queued", "b:queued"])
        queue.close()
      }),
    ))

  it("holds one actor's later commands behind a stuck one without holding another actor's", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, attempts } = fixture({
          steps: {
            a: [refuse(offline, 20), refuse(offline, 20), Effect.succeed("ok:a")],
          },
        })

        const a = yield* submit(queue, "a", "/actors/Room/r1")
        const b = yield* submit(queue, "b", "/actors/Room/r1")
        const c = yield* submit(queue, "c", "/actors/Room/r2")

        expect(yield* c.settled).toBe("ok:c")
        expect(yield* a.settled).toBe("ok:a")
        expect(yield* b.settled).toBe("ok:b")
        expect(attempts.filter((id) => id === "a").length).toBe(3)
        expect(attempts.indexOf("c")).toBeLessThan(attempts.lastIndexOf("a"))
        expect(attempts.indexOf("b")).toBeGreaterThan(attempts.lastIndexOf("a"))
      }),
    ))

  it("retries under the same id and keeps the command saved until the server answers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, store, attempts } = fixture({
          steps: { a: [refuse(offline, 15), refuse(offline, 15), Effect.succeed("ok:a")] },
        })

        const delivery = yield* submit(queue, "a")

        yield* until(() => attempts.length >= 1 && queue.pending[0]?.failure !== undefined)
        expect(reasonOf(queue.pending[0]!.failure!)).toHaveProperty("_tag", "TransportError")
        expect(yield* saved(store)).toEqual(["a:queued"])
        expect(yield* delivery.settled).toBe("ok:a")
        expect(attempts).toEqual(["a", "a", "a"])
        yield* until(() => queue.pending.length === 0)
        expect(yield* saved(store)).toEqual([])
      }),
    ))

  it("expires a saved command whose id passed its window without sending it, and keeps it for the application", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = Offline.memory()

        yield* seed(store, stored(expiredId), stored("later", { sequence: 1 }))

        const { queue, attempts } = fixture({ store })

        yield* until(() => attempts.includes("later") && queue.pending.length === 1)

        expect(attempts).toEqual(["later"])
        expect(queue.pending.map((pending) => `${pending.commandId}:${pending.status}`)).toEqual([
          `${expiredId}:expired`,
        ])
        expect(reasonOf(queue.pending[0]!.failure!)).toHaveProperty("commandId", expiredId)
        expect(yield* saved(store)).toEqual([`${expiredId}:expired`])

        yield* Effect.promise(() => queue.discard(expiredId))

        expect(queue.pending).toEqual([])
        expect(yield* saved(store)).toEqual([])
      }),
    ))

  it("expires instead of waiting past the id's window, and tells the caller with the id", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = liveId(4_000)
        const { queue, attempts, store } = fixture({ steps: { [id]: [refuse(offline, 5_000)] } })

        const delivery = yield* submit(queue, id)
        const failure = yield* Effect.flip(delivery.settled)

        expect(reasonOf(failure)).toHaveProperty("_tag", "CommandExpired")
        expect(reasonOf(failure)).toHaveProperty("commandId", id)
        expect(attempts).toEqual([id])
        expect(yield* saved(store)).toEqual([`${id}:expired`])
        expect(queue.pending.map((pending) => pending.status)).toEqual(["expired"])
      }),
    ))

  it("expires a command the clock has moved past between attempts", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const id = liveId(60_000)
        let clock = NOW

        const { queue, attempts } = fixture({
          steps: { [id]: [refuse(offline, 20)] },
          now: () => clock,
        })

        const delivery = yield* submit(queue, id)

        yield* until(() => attempts.length === 1)
        clock = NOW + 120_000

        const failure = yield* Effect.flip(delivery.settled)

        expect(reasonOf(failure)).toHaveProperty("_tag", "CommandExpired")
        expect(attempts).toEqual([id])
      }),
    ))

  it("keeps a terminal failure with its answer for the application and does not hold back later commands", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = Offline.memory()

        const { queue } = fixture({
          store,
          steps: { a: [refuse(rejected, undefined, { status: 400, text: "refused" })] },
        })

        const a = yield* submit(queue, "a")
        const b = yield* submit(queue, "b")

        expect(yield* Effect.flip(a.settled)).toBe(rejected)
        expect(yield* b.settled).toBe("ok:b")
        expect(yield* saved(store)).toEqual(["a:failed"])

        const [entry] = yield* Effect.promise(() => store.entries())

        expect(entry?.answer).toEqual({ status: 400, text: "refused" })

        const reopened = fixture({ store })

        yield* Effect.promise(() => reopened.queue.ready)

        expect(reopened.queue.pending.map((pending) => pending.status)).toEqual(["failed"])
        expect(reasonOf(reopened.queue.pending[0]!.failure!)).toHaveProperty("status", 400)
        expect(reopened.attempts).toEqual([])

        yield* Effect.promise(() => reopened.queue.discard("a"))

        expect(yield* saved(store)).toEqual([])
      }),
    ))

  it("stops an actor on a rejected credential until flushed, then resumes with the same id", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, attempts } = fixture({
          steps: { a: [refuse(signedOut), Effect.succeed("ok:a")] },
        })

        const a = yield* submit(queue, "a", "/actors/Room/r1")

        yield* until(() => queue.pending[0]?.failure !== undefined)

        const other = yield* submit(queue, "c", "/actors/Room/r2")

        expect(yield* other.settled).toBe("ok:c")
        yield* Effect.sleep("50 millis")
        expect(attempts.filter((id) => id !== "c")).toEqual(["a"])
        expect(queue.pending.map((pending) => pending.commandId)).toEqual(["a"])

        queue.flush()

        expect(yield* a.settled).toBe("ok:a")
        expect(attempts.filter((id) => id !== "c")).toEqual(["a", "a"])
        queue.close()
      }),
    ))

  it("resumes a stopped actor when the application queues another command for it, keeping order", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, attempts } = fixture({
          steps: { a: [refuse(signedOut), Effect.succeed("ok:a")] },
        })

        const a = yield* submit(queue, "a")

        yield* until(() => queue.pending[0]?.failure !== undefined)
        yield* Effect.sleep("30 millis")
        expect(attempts).toEqual(["a"])

        const b = yield* submit(queue, "b")

        expect(yield* a.settled).toBe("ok:a")
        expect(yield* b.settled).toBe("ok:b")
        expect(attempts).toEqual(["a", "a", "b"])
        queue.close()
      }),
    ))

  it("delivers what an earlier session left saved, under the same ids and in order, and leaves other clients' commands alone", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = Offline.memory()

        const before = fixture({
          store,
          steps: { a: [refuse(offline, 10)], b: [refuse(offline, 10)] },
        })

        yield* seed(
          store,
          stored("other-url", { sequence: 7, baseUrl: "/elsewhere" }),
          stored("other-actor", { sequence: 8, target: "/actors/Cursor/x" }),
        )

        yield* submit(before.queue, "a")
        yield* submit(before.queue, "b")
        yield* until(() => before.attempts.length >= 1)
        before.queue.close()

        const after = fixture({ store })

        yield* until(() => after.attempts.length === 2 && after.queue.pending.length === 0)

        expect(after.attempts).toEqual(["a", "b"])
        expect(yield* saved(store)).toEqual(["other-url:queued", "other-actor:queued"])

        const next = fixture({ store, steps: { c: [refuse(offline, 60_000)] } })

        yield* submit(next.queue, "c")

        const c = (yield* Effect.promise(() => store.entries())).find(
          (entry) => entry.commandId === "c",
        )

        expect(c?.sequence).toBe(9)
        next.queue.close()
      }),
    ))

  it("joins a repeated id to the command already queued, and refuses the same id with different input", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, attempts, store } = fixture({
          steps: { a: [refuse(offline, 20), Effect.succeed("ok:a")] },
        })

        const first = yield* submit(queue, "a")
        const again = yield* submit(queue, "a")

        expect(yield* saved(store)).toEqual(["a:queued"])

        const refused = yield* Effect.tryPromise({
          try: () => queue.submit(command("a", undefined, '{"text":"other"}'), undefined),
          catch: (thrown) => thrown as Failure,
        }).pipe(Effect.flip)

        expect(reasonOf(refused)).toHaveProperty("_tag", "CommandConflict")
        expect(yield* first.settled).toBe("ok:a")
        expect(yield* again.settled).toBe("ok:a")
        expect(attempts).toEqual(["a", "a"])
        yield* until(() => queue.pending.length === 0)
      }),
    ))

  it("tells a caller who repeats an expired id that it expired, without sending it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, attempts } = fixture()

        const first = yield* submit(queue, expiredId)

        expect(reasonOf(yield* Effect.flip(first.settled))).toHaveProperty("_tag", "CommandExpired")

        const again = yield* submit(queue, expiredId)

        expect(reasonOf(yield* Effect.flip(again.settled))).toHaveProperty("_tag", "CommandExpired")
        expect(attempts).toEqual([])
        expect(queue.pending.map((pending) => pending.status)).toEqual(["expired"])
      }),
    ))

  it("fails a command it could not save without sending it, and recovers when the store does", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const base = Offline.memory()
        let failing = true

        const flaky: OfflineStore = {
          ...base,
          save: (entry) => (failing ? Promise.reject(new Error("quota")) : base.save(entry)),
        }

        const { queue, attempts } = fixture({ store: flaky })

        const failure = yield* Effect.tryPromise({
          try: () => queue.submit(command("a"), undefined),
          catch: (thrown) => thrown as Failure,
        }).pipe(Effect.flip)

        expect(failure).toHaveProperty("_tag", "OfflineStoreError")
        expect(failure).toHaveProperty("operation", "save")
        expect(attempts).toEqual([])
        expect(queue.pending).toEqual([])
        expect(yield* saved(base)).toEqual([])

        failing = false

        const delivery = yield* submit(queue, "b")

        expect(yield* delivery.settled).toBe("ok:b")
        expect(attempts).toEqual(["b"])
      }),
    ))

  it("fails every submit when the saved commands cannot be read", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unreadable: OfflineStore = {
          ...Offline.memory(),
          entries: () => Promise.reject(new Error("blocked")),
        }

        const { queue, attempts } = fixture({ store: unreadable })

        const loading = yield* Effect.tryPromise({
          try: () => queue.ready,
          catch: (thrown) => thrown as Failure,
        }).pipe(Effect.flip)

        const submitting = yield* Effect.tryPromise({
          try: () => queue.submit(command("a"), undefined),
          catch: (thrown) => thrown as Failure,
        }).pipe(Effect.flip)

        expect(loading).toHaveProperty("operation", "entries")
        expect(submitting).toHaveProperty("_tag", "OfflineStoreError")
        expect(attempts).toEqual([])
      }),
    ))

  it("queues nothing for a call aborted before its command was saved", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, store, attempts } = fixture()
        const early = controller()

        early.abort()

        const before = yield* Effect.promise(() => queue.submit(command("a"), early.signal))

        const midway = controller()
        const minting = Deferred.makeUnsafe<void>()
        const minted = Deferred.makeUnsafe<void>()

        const slow = Deferred.succeed(minting, undefined).pipe(
          Effect.andThen(Deferred.await(minted)),
          Effect.andThen(command("b")),
        )

        const during = queue.submit(slow, midway.signal)

        yield* Deferred.await(minting)
        midway.abort()
        yield* Deferred.succeed(minted, undefined)

        expect(before).toBeUndefined()
        expect(yield* Effect.promise(() => during)).toBeUndefined()
        expect(yield* saved(store)).toEqual([])
        expect(attempts).toEqual([])
      }),
    ))

  it("forgets a discarded command, settles its caller with Timeout, and never sends it again", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, store, attempts } = fixture({ steps: { a: [refuse(offline, 15)] } })

        const delivery = yield* submit(queue, "a")

        yield* until(() => attempts.length >= 1)
        yield* Effect.promise(() => queue.discard("a"))

        const failure = yield* Effect.flip(delivery.settled)
        const sent = attempts.length

        yield* Effect.sleep("60 millis")

        expect(reasonOf(failure)).toHaveProperty("_tag", "Timeout")
        expect(reasonOf(failure)).toHaveProperty("commandId", "a")
        expect(attempts.length).toBe(sent)
        expect(queue.pending).toEqual([])
        expect(yield* saved(store)).toEqual([])
      }),
    ))

  it("stops delivering when closed and leaves the command saved for the next session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, store, attempts } = fixture({ steps: { a: [refuse(offline, 15)] } })

        yield* submit(queue, "a")
        yield* until(() => attempts.length >= 1)
        queue.close()
        yield* Effect.sleep("30 millis")

        const sent = attempts.length

        yield* Effect.sleep("60 millis")

        expect(attempts.length).toBe(sent)
        expect(yield* saved(store)).toEqual(["a:queued"])
      }),
    ))

  it("still answers its caller when the store cannot forget a committed command, and reports it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reported = vi.spyOn(globalThis, "reportError").mockImplementation(() => undefined)
        const base = Offline.memory()
        const stuck: OfflineStore = { ...base, remove: () => Promise.reject(new Error("disk")) }
        const { queue } = fixture({ store: stuck })

        const delivery = yield* submit(queue, "a")

        expect(yield* delivery.settled).toBe("ok:a")
        yield* until(() => reported.mock.calls.length === 1)
        expect(reported.mock.calls[0]?.[0]).toHaveProperty("operation", "remove")
        expect(yield* saved(base)).toEqual(["a:queued"])
      }),
    ))

  it("tries again at once when the browser reports it is back online", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { queue, attempts } = fixture({
          steps: { a: [refuse(offline, 60_000), Effect.succeed("ok:a")] },
        })

        const delivery = yield* submit(queue, "a")

        yield* until(() => attempts.length === 1)
        globalThis.dispatchEvent(new Event("online"))

        expect(yield* delivery.settled).toBe("ok:a")
        expect(attempts).toEqual(["a", "a"])
        queue.close()
      }),
    ))

  it("tells subscribers about each change until they unsubscribe, and reports a listener that throws", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const reported = vi.spyOn(globalThis, "reportError").mockImplementation(() => undefined)
        const { queue } = fixture({ steps: { a: [refuse(offline, 60_000)] } })
        const seen: Array<ReadonlyArray<string>> = []

        queue.subscribe(() => {
          throw new Error("listener")
        })

        const stop = queue.subscribe((pending) =>
          seen.push(pending.map((entry) => `${entry.commandId}:${entry.status}`)),
        )

        yield* submit(queue, "a")
        yield* until(() => queue.pending[0]?.failure !== undefined)
        stop()
        yield* submit(queue, "b")

        expect(seen[0]).toEqual([])
        expect(seen.some((names) => names.join() === "a:queued")).toBe(true)
        expect(seen.at(-1)).toEqual(["a:queued"])
        expect(seen.some((names) => names.includes("b:queued"))).toBe(false)
        expect(reported.mock.calls.length).toBeGreaterThan(0)
        queue.close()
      }),
    ))
})
