import { Effect, Schedule, Schema } from "effect"
import type { OfflineQueue } from "../../../../packages/akter/src/client/index.ts"
import {
  Offline,
  OfflineStoreError,
  type OfflineStore,
  type QueuedCommand,
} from "../../../../packages/akter/src/client/offline/store.ts"
import { ActorError } from "../../../../packages/akter/src/errors/actor.ts"
import { InternalActors } from "../../../../packages/akter/src/runtime/actors.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import {
  Full,
  HttpRoom,
  HttpTally,
  posted,
  receipts,
  runs,
  serveHttp,
  tenantOf,
  httpSuite,
} from "./http.ts"

const baseFetch = globalThis.fetch.bind(globalThis)

/** A request that reached the network, with the command id it carried. */
interface Sent {
  readonly path: string
  readonly key: string | null
}

/**
 * A `fetch` the case can cut. While cut, requests fail as a lost network does,
 * before reaching the server; `loseNextCommand` lets one command reach the
 * server and then cuts the network before its reply returns.
 */
interface Wire {
  down: boolean
  blocked: (path: string) => boolean
  loseNextCommand: boolean
  readonly sent: Array<Sent>
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readonly commands: (member: string) => ReadonlyArray<string | null>
}

const wire = (): Wire => {
  const state: Wire = {
    down: false,
    blocked: () => false,
    loseNextCommand: false,
    sent: [],
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const key = new Headers(init?.headers).get("idempotency-key")

      if (state.down || state.blocked(url.pathname))
        return Promise.reject(new TypeError("network down"))

      state.sent.push({ path: url.pathname, key })

      return baseFetch(input, init).then((response) => {
        if (!state.loseNextCommand || key === null) return response

        state.loseNextCommand = false
        state.down = true

        return response.text().then(() => Promise.reject(new TypeError("reply lost")))
      })
    },
    commands: (member) =>
      state.sent.filter((sent) => sent.path.endsWith(`/${member}`)).map((sent) => sent.key),
  }

  return state
}

const until = (condition: () => boolean) =>
  Effect.suspend(() => (condition() ? Effect.void : Effect.fail("waiting"))).pipe(
    Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 1_000 }),
    Effect.orDie,
  )

type Settled<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown }

const settle = <A>(promise: Promise<A>) =>
  Effect.tryPromise(() => promise).pipe(
    Effect.match({
      onSuccess: (value): Settled<A> => ({ ok: true, value }),
      onFailure: (failure): Settled<A> => ({ ok: false, error: failure.cause }),
    }),
  )

const isActorError = Schema.is(ActorError)

/** A rejected call's framework reason as `{ tag, ...fields }`, or undefined. */
const reasonOf = (settled: Settled<unknown>) => {
  if (settled.ok || !isActorError(settled.error)) return undefined

  const reason = settled.error.reason

  return Object.assign({ tag: reason._tag }, reason)
}

const queueOf = (client: { readonly offline: OfflineQueue | undefined }) => client.offline!

const idsOf = (queue: OfflineQueue) => queue.pending.map((pending) => pending.commandId)

const savedIds = (store: OfflineStore) =>
  Effect.promise(() => store.entries()).pipe(
    Effect.map((entries) => entries.map((entry) => entry.commandId)),
  )

const bearer = (tenant: string) => ({ authorization: `Bearer ${tenant}:alice` })

export const offlineConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "offline client queues commands while the network is down, then replays them in order under their original ids, each applied once",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(rooms)

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)
          yield* Effect.promise(() => rooms.commandId())

          network.down = true

          const firstPost = posted.length
          const ran = runs.count
          const room = rooms.get("queued")
          const calls = ["one", "two", "three"].map((text) =>
            room.Post({ text }, { timeoutInMs: 300 }),
          )
          const settled = yield* Effect.promise(() => Promise.allSettled(calls))

          expect(settled.map((call) => call.status)).toEqual(["rejected", "rejected", "rejected"])

          const queued = idsOf(queue)

          expect(queued.length).toBe(3)
          expect(new Set(queued).size).toBe(3)
          expect(queue.pending.map((pending) => pending.status)).toEqual([
            "queued",
            "queued",
            "queued",
          ])
          expect(yield* savedIds(store)).toEqual(queued)
          expect(posted.length).toBe(firstPost)
          expect(runs.count).toBe(ran)

          expect(yield* receipts(tenant, "HttpRoom", "queued")).toBe(0)

          network.down = false
          queue.flush()
          yield* until(() => queue.pending.length === 0)

          expect(posted.slice(firstPost)).toEqual(["one", "two", "three"])
          expect(runs.count - ran).toBe(3)
          expect(yield* receipts(tenant, "HttpRoom", "queued")).toBe(3)
          expect(network.commands("Post")).toEqual(queued)
          expect(yield* savedIds(store)).toEqual([])
        }),
      ),
  },
  {
    name: "offline client replays a command whose reply was lost, after a reload, with its original id: the receipt answers and the handler ran once",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()
          const ran = runs.count

          const before = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const first = queueOf(before)

          yield* Effect.addFinalizer(() => Effect.sync(() => first.close()))
          yield* Effect.promise(() => first.ready)
          yield* Effect.promise(() => before.commandId())

          network.loseNextCommand = true

          const lost = yield* settle(
            before.get("reload").Post({ text: "once" }, { timeoutInMs: 300 }),
          )
          const id = idsOf(first)[0]!

          expect(reasonOf(lost)).toMatchObject({ tag: "Timeout", commandId: id })
          expect(runs.count - ran).toBe(1)
          expect(yield* receipts(tenant, "HttpRoom", "reload")).toBe(1)
          expect(yield* savedIds(store)).toEqual([id])

          first.close()
          network.down = false

          const after = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const second = queueOf(after)

          yield* Effect.addFinalizer(() => Effect.sync(() => second.close()))
          yield* until(() => second.pending.length === 0 && network.commands("Post").length >= 2)

          expect(network.commands("Post").slice(0, 2)).toEqual([id, id])
          expect(runs.count - ran).toBe(1)
          expect(yield* receipts(tenant, "HttpRoom", "reload")).toBe(1)
          expect(yield* savedIds(store)).toEqual([])
        }),
      ),
  },
  {
    name: "offline client fails a queued command older than the id window as CommandExpired without sending it or minting another id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const actors = yield* InternalActors
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()
          const expired = yield* server.mint(-actors.retryWindowMs - 1)

          const stale: QueuedCommand = {
            commandId: expired,
            sequence: 0,
            baseUrl: server.url,
            principal: `${tenant}/alice`,
            target: "/actors/HttpRoom/stale",
            member: "Post",
            body: '{"text":"old"}',
            status: "queued",
            answer: undefined,
          }

          yield* Effect.promise(() => store.save(stale))

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(rooms)
          const ran = runs.count

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)

          expect(queue.pending.map((pending) => pending.status)).toEqual(["expired"])
          expect(queue.pending[0]?.failure).toBeInstanceOf(ActorError)
          expect(queue.pending[0]?.input).toEqual({ text: "old" })

          const explicit = yield* settle(
            rooms.get("stale").Post({ text: "old" }, { commandId: expired }),
          )

          expect(reasonOf(explicit)).toMatchObject({ tag: "CommandExpired", commandId: expired })
          expect(network.commands("Post")).toEqual([])
          expect(runs.count).toBe(ran)
          expect(yield* receipts(tenant, "HttpRoom", "stale")).toBe(0)
          expect(yield* savedIds(store)).toEqual([expired])

          yield* Effect.promise(() => queue.discard(expired))

          expect(yield* savedIds(store)).toEqual([])

          const fresh = yield* settle(rooms.get("stale").Post({ text: "new" }))

          expect(fresh).toEqual({ ok: true, value: 1 })
          expect(network.commands("Post").length).toBe(1)
          expect(network.commands("Post")[0]).not.toBe(expired)
          expect(runs.count - ran).toBe(1)
        }),
      ),
  },
  {
    name: "offline client joins a repeated id to the queued command, and the receipt replays a committed id or refuses it with other input",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(rooms)
          const room = rooms.get("dedup")

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)

          const id = yield* Effect.promise(() => rooms.commandId())

          network.down = true

          const ran = runs.count

          const both = yield* Effect.promise(() =>
            Promise.allSettled([
              room.Post({ text: "a" }, { commandId: id, timeoutInMs: 300 }),
              room.Post({ text: "a" }, { commandId: id, timeoutInMs: 300 }),
            ]),
          )

          expect(both.map((call) => call.status)).toEqual(["rejected", "rejected"])
          expect(yield* savedIds(store)).toEqual([id])

          network.down = false
          queue.flush()
          yield* until(() => queue.pending.length === 0)

          expect(runs.count - ran).toBe(1)
          expect(yield* receipts(tenant, "HttpRoom", "dedup")).toBe(1)

          const replay = yield* settle(room.Post({ text: "a" }, { commandId: id }))

          expect(replay).toEqual({ ok: true, value: 1 })
          expect(runs.count - ran).toBe(1)

          const other = yield* settle(room.Post({ text: "different" }, { commandId: id }))

          expect(reasonOf(other)).toMatchObject({ tag: "CommandConflict", commandId: id })
          expect(runs.count - ran).toBe(1)
          expect(yield* receipts(tenant, "HttpRoom", "dedup")).toBe(1)
          expect(queue.pending.map((pending) => pending.status)).toEqual(["failed"])

          yield* Effect.promise(() => queue.discard(id))
          expect(yield* savedIds(store)).toEqual([])
        }),
      ),
  },
  {
    name: "offline client keeps each actor's commands in call order while another actor's commands are not held back",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(rooms)

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)
          yield* Effect.promise(() => rooms.commandId())

          network.blocked = (path) => path.includes("/blocked/")

          const start = posted.length

          const calls = [
            rooms.get("blocked").Post({ text: "blocked-1" }, { timeoutInMs: 200 }),
            rooms.get("open").Post({ text: "open-1" }),
            rooms.get("blocked").Post({ text: "blocked-2" }, { timeoutInMs: 200 }),
            rooms.get("open").Post({ text: "open-2" }),
          ]

          const settled = yield* Effect.promise(() => Promise.allSettled(calls))

          expect(settled).toMatchObject([
            { status: "rejected" },
            { status: "fulfilled", value: 1 },
            { status: "rejected" },
            { status: "fulfilled", value: 2 },
          ])
          yield* until(() =>
            queue.pending.every((pending) => pending.target !== "/actors/HttpRoom/open"),
          )

          expect(posted.slice(start)).toEqual(["open-1", "open-2"])
          expect(queue.pending.map((pending) => pending.target)).toEqual([
            "/actors/HttpRoom/blocked",
            "/actors/HttpRoom/blocked",
          ])

          network.blocked = () => false
          queue.flush()
          yield* until(() => queue.pending.length === 0)

          expect(posted.slice(start)).toEqual(["open-1", "open-2", "blocked-1", "blocked-2"])
          expect(yield* receipts(tenant, "HttpRoom", "blocked")).toBe(2)
        }),
      ),
  },
  {
    name: "offline client keeps a command the server rejected for good, decoded as its declared error after a reload, until the application discards it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()

          const options = {
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          }

          const rooms = HttpRoom.client(options)
          const queue = queueOf(rooms)

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)
          yield* Effect.promise(() => rooms.commandId())

          network.down = true

          const call = rooms.get("rejected").Post({ text: "full" }, { timeoutInMs: 200 })
          const timedOut = yield* settle(call)

          expect(reasonOf(timedOut)).toMatchObject({ tag: "Timeout" })

          const id = idsOf(queue)[0]!

          network.down = false
          queue.flush()
          yield* until(() => queue.pending[0]?.status === "failed")
          queue.close()

          const reloaded = queueOf(HttpRoom.client(options))

          yield* Effect.addFinalizer(() => Effect.sync(() => reloaded.close()))
          yield* Effect.promise(() => reloaded.ready)

          expect(reloaded.pending.map((pending) => pending.status)).toEqual(["failed"])
          expect(reloaded.pending[0]?.failure).toBeInstanceOf(Full)
          expect(network.commands("Post")).toEqual([id])
          expect(yield* receipts(tenant, "HttpRoom", "rejected")).toBe(1)

          yield* Effect.promise(() => reloaded.discard(id))

          expect(yield* savedIds(store)).toEqual([])
        }),
      ),
  },
  {
    name: "offline client stops an actor's queue on a rejected credential and resumes it under the same id once a valid one is supplied",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()
          let token = `${tenant}:alice`

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: () => ({ authorization: `Bearer ${token}` }),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(rooms)

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)
          yield* Effect.promise(() => rooms.commandId())

          token = "malformed"

          const ran = runs.count
          const call = yield* settle(
            rooms.get("signed-out").Post({ text: "held" }, { timeoutInMs: 300 }),
          )
          const id = idsOf(queue)[0]!

          expect(reasonOf(call)).toMatchObject({ tag: "Timeout", commandId: id })
          expect(queue.pending[0]?.status).toBe("queued")
          expect(runs.count).toBe(ran)

          token = `${tenant}:alice`
          queue.flush()
          yield* until(() => queue.pending.length === 0)

          expect(runs.count - ran).toBe(1)
          expect(new Set(network.commands("Post"))).toEqual(new Set([id]))
          expect(yield* receipts(tenant, "HttpRoom", "signed-out")).toBe(1)
        }),
      ),
  },
  {
    name: "offline client holds the commands another principal queued on a shared store, sends only the signed-in principal's, and delivers the held ones once their principal signs back in",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()

          const signIn = (subject: string) =>
            Effect.gen(function* () {
              const client = HttpRoom.client({
                baseUrl: server.url,
                headers: { authorization: `Bearer ${tenant}:${subject}` },
                identity: () => `${tenant}/${subject}`,
                fetch: network.fetch,
                offline: store,
              })

              const queue = queueOf(client)

              yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
              yield* Effect.promise(() => queue.ready)
              yield* Effect.promise(() => client.commandId())

              return { client, queue }
            })

          const alice = yield* signIn("alice")

          network.down = true

          const ran = runs.count
          const queued = yield* settle(
            alice.client.get("shared").Post({ text: "from alice" }, { timeoutInMs: 300 }),
          )
          const aliceId = idsOf(alice.queue)[0]!

          expect(reasonOf(queued)).toMatchObject({ tag: "Timeout", commandId: aliceId })
          alice.queue.close()

          network.down = false

          const bob = yield* signIn("bob")

          yield* until(() => bob.queue.pending[0]?.status === "held")
          bob.queue.flush()

          const own = yield* settle(bob.client.get("bobs").Post({ text: "from bob" }))

          expect(own.ok).toBe(true)
          yield* Effect.sleep("200 millis")

          expect(runs.count - ran).toBe(1)
          expect(network.commands("Post").includes(aliceId)).toBe(false)
          expect(yield* receipts(tenant, "HttpRoom", "shared")).toBe(0)
          expect(bob.queue.pending.map((pending) => [pending.commandId, pending.status])).toEqual([
            [aliceId, "held"],
          ])
          bob.queue.close()

          const back = yield* signIn("alice")

          back.queue.flush()
          yield* until(() => back.queue.pending.length === 0)

          expect(runs.count - ran).toBe(2)
          expect(yield* receipts(tenant, "HttpRoom", "shared")).toBe(1)
          expect(yield* savedIds(store)).toEqual([])
        }),
      ),
  },
  {
    name: "offline client rejects a command its store could not save, and never sends it",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const base = Offline.memory()

          const full: OfflineStore = {
            ...base,
            save: () => Promise.reject(new Error("quota exceeded")),
          }

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: full,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(rooms)

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)

          const ran = runs.count
          const result = yield* settle(rooms.get("unsaved").Post({ text: "lost" }))

          expect(result.ok).toBe(false)
          expect(result.ok ? undefined : result.error).toBeInstanceOf(OfflineStoreError)
          expect(network.commands("Post")).toEqual([])
          expect(runs.count).toBe(ran)
          expect(yield* receipts(tenant, "HttpRoom", "unsaved")).toBe(0)
          expect(queue.pending).toEqual([])
        }),
      ),
  },
  {
    name: "offline client keeps an optimistic reducer applied through the outage and settles on the committed state once replayed",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const network = wire()
          const store = Offline.memory()

          const tallies = HttpTally.client({
            baseUrl: server.url,
            headers: bearer(tenant),
            fetch: network.fetch,
            offline: store,
            identity: () => `${tenant}/alice`,
          })

          const queue = queueOf(tallies)
          const tally = tallies.get("outage")

          yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()))
          yield* Effect.promise(() => queue.ready)
          yield* Effect.promise(() => tallies.commandId())

          tally.state.reconcile({ count: 0 })
          network.down = true

          const calls = [tally.Bump({ timeoutInMs: 200 }), tally.Bump({ timeoutInMs: 200 })]

          yield* Effect.promise(() => Promise.allSettled(calls))

          expect(tally.state.current).toEqual({ count: 2 })
          expect(tally.state.pending.length).toBe(2)

          network.down = false
          queue.flush()
          yield* until(() => queue.pending.length === 0 && tally.state.pending.length === 0)

          expect(tally.state.current).toEqual({ count: 2 })

          const committed = yield* Effect.promise(() =>
            HttpTally.client({ baseUrl: server.url, headers: bearer(tenant) })
              .get("outage")
              .Snapshot(),
          )

          expect(committed).toEqual({ count: 2 })
        }),
      ),
  },
]

/** Offline cases call the served HTTP actors. */
export const offlineSuite: ConformanceSuite = {
  uses: [httpSuite],
}
