import { Effect, Schema } from "effect"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, describe, expect, it } from "vitest"
import { Offline, type OfflineStore, type QueuedCommand } from "./store.ts"

const saved = (commandId: string, sequence: number): QueuedCommand => ({
  commandId,
  sequence,
  baseUrl: "/api",
  target: "/actors/Room/r1",
  member: "Post",
  body: `{"text":"${commandId}"}`,
  status: "queued",
  answer: undefined,
})

const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")

const install = (factory: IDBFactory) => {
  Object.defineProperty(globalThis, "indexedDB", {
    value: factory,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, "indexedDB")
  else Object.defineProperty(globalThis, "indexedDB", original)
})

const ids = (store: OfflineStore) =>
  Effect.promise(() => store.entries()).pipe(
    Effect.map((commands) => commands.map((command) => command.commandId)),
  )

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { cause: Schema.Defect() }) {}

const rejection = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (cause) => Rejected.make({ cause }) }).pipe(
    Effect.flip,
    Effect.map((rejected) => rejected.cause),
  )

const contract = (name: string, open: () => OfflineStore) =>
  describe(`${name} offline store`, () => {
    it("lists commands in the order they were queued, whatever order they were saved in", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = open()

          yield* Effect.promise(() => store.save(saved("c", 3)))
          yield* Effect.promise(() => store.save(saved("a", 1)))
          yield* Effect.promise(() => store.save(saved("b", 2)))

          expect(yield* ids(store)).toEqual(["a", "b", "c"])
        }),
      ))

    it("replaces a command saved under the same id and forgets one on removal", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = open()

          yield* Effect.promise(() => store.save(saved("a", 1)))
          yield* Effect.promise(() => store.save({ ...saved("a", 1), status: "expired" }))
          yield* Effect.promise(() => store.save(saved("b", 2)))
          yield* Effect.promise(() => store.remove("b"))
          yield* Effect.promise(() => store.remove("never-saved"))

          expect(yield* Effect.promise(() => store.entries())).toEqual([
            { ...saved("a", 1), status: "expired" },
          ])
        }),
      ))

    it("keeps a terminal answer and an absent body exactly as saved", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = open()

          const failed: QueuedCommand = {
            ...saved("f", 1),
            body: undefined,
            status: "failed",
            answer: { status: 423, text: '{"_tag":"Closed"}' },
          }

          yield* Effect.promise(() => store.save(failed))

          expect(yield* Effect.promise(() => store.entries())).toEqual([failed])
        }),
      ))

    it("hands out copies, so changing what was read or saved changes nothing stored", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = open()
          const command = saved("a", 1)

          yield* Effect.promise(() => store.save(command))
          Object.assign(command, { member: "Changed" })

          const [read] = yield* Effect.promise(() => store.entries())

          Object.assign(read!, { member: "Also changed" })

          const again = yield* Effect.promise(() => store.entries())

          expect(again.map((entry) => entry.member)).toEqual(["Post"])
        }),
      ))
  })

contract("in-memory", () => Offline.memory())

let names = 0

contract("IndexedDB", () => {
  install(new IDBFactory())
  names += 1

  return Offline.indexedDb(`contract-${names}`)
})

describe("IndexedDB offline store", () => {
  it("keeps commands for a store opened again under the same name, as after a reload, and apart from other names", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        install(new IDBFactory())
        yield* Effect.promise(() => Offline.indexedDb("chat").save(saved("a", 1)))
        yield* Effect.promise(() => Offline.indexedDb("other").save(saved("z", 1)))

        expect(yield* ids(Offline.indexedDb("chat"))).toEqual(["a"])
      }),
    ))

  it("rejects while there is no IndexedDB and works once there is, without keeping the failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = Offline.indexedDb("late")

        Reflect.deleteProperty(globalThis, "indexedDB")

        const absent = yield* rejection(() => store.save(saved("a", 1)))

        expect(absent).toHaveProperty("_tag", "IndexedDbUnavailable")
        expect(absent).toHaveProperty("reason", "absent")

        install(new IDBFactory())
        yield* Effect.promise(() => store.save(saved("a", 1)))

        expect(yield* ids(store)).toEqual(["a"])
      }),
    ))

  it("rejects a save the browser cannot store, and leaves what was saved before it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        install(new IDBFactory())

        const store = Offline.indexedDb("unstorable")

        yield* Effect.promise(() => store.save(saved("a", 1)))

        const unstorable = yield* rejection(() =>
          store.save(Object.assign(saved("b", 2), { hook: () => undefined })),
        )

        expect(unstorable).toHaveProperty("name", "DataCloneError")
        expect(yield* ids(store)).toEqual(["a"])
      }),
    ))
})
