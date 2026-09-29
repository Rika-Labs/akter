import { Effect, Redacted, Schedule, type Scope } from "effect"
import { HttpRoom, serveHttp, tenantOf, type Server } from "./http.ts"
import type {
  ConformanceCase,
  ConformanceConnection,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"

const VERSION = /^(0|[1-9]\d*)$/

/**
 * Runs `body` on a runtime whose queries read `replica`, in place of the
 * suite's runtime, which is restarted afterwards. Two runtimes never serve one
 * database at once, since both would claim its shards.
 */
const withReplica = async <A>(
  environment: ConformanceEnvironment,
  replica: Redacted.Redacted<string>,
  body: Effect.Effect<A, never, ConformanceServices | Scope.Scope>,
) => {
  await Effect.runPromise(environment.stop)
  const runtime = environment.build({ replica })

  try {
    return await runtime.runPromise(Effect.scoped(body))
  } finally {
    await runtime.dispose()
    await Effect.runPromise(environment.restart)
  }
}

/** Replay on the replica stays paused for the rest of the scope. */
const pauseReplay = (control: ConformanceConnection) =>
  Effect.acquireRelease(control.query("SELECT pg_wal_replay_pause()"), () =>
    Effect.asVoid(control.query("SELECT pg_wal_replay_resume()")),
  )

const resumeReplay = (control: ConformanceConnection) =>
  Effect.asVoid(control.query("SELECT pg_wal_replay_resume()"))

/** Waits until the replica has replayed through `version`. */
const replayedThrough = (control: ConformanceConnection, version: string) =>
  control
    .query("SELECT coalesce(pg_last_wal_replay_lsn() - '0/0' >= $1::numeric, false) AS ready", [
      version,
    ])
    .pipe(
      Effect.flatMap((rows) =>
        (rows[0] as { ready: boolean }).ready
          ? Effect.void
          : Effect.fail(new Error(`replica has not replayed ${version}`)),
      ),
      Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
      Effect.orDie,
    )

const post = (server: Server, token: string, key: string) =>
  Effect.gen(function* () {
    const reply = yield* server.send(`/actors/HttpRoom/${key}/Post`, {
      token,
      key: yield* server.mint(),
      body: { text: "a" },
    })

    return reply
  })

const count = (server: Server, token: string, key: string, minVersion?: string) =>
  server.send(`/actors/HttpRoom/${key}/Count`, {
    token,
    headers: minVersion === undefined ? {} : { "durable-min-version": minVersion },
  })

export const readYourWritesConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "answers every committed command with durable-version, and a replay with one at least as high",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`
          const key = yield* server.mint()

          const first = yield* server.send("/actors/HttpRoom/versioned/Post", {
            token,
            key,
            body: { text: "a" },
          })
          const second = yield* post(server, token, "versioned")

          const replayed = yield* server.send("/actors/HttpRoom/versioned/Post", {
            token,
            key,
            body: { text: "a" },
          })

          const versions = [first, second, replayed].map((reply) =>
            reply.headers.get("durable-version"),
          )

          expect([first.status, second.status, replayed.status]).toEqual([200, 200, 200])
          expect(versions.every((version) => version !== null && VERSION.test(version))).toBe(true)
          expect(BigInt(versions[1]!) > BigInt(versions[0]!)).toBe(true)
          expect(BigInt(versions[2]!) >= BigInt(versions[0]!)).toBe(true)
          expect(replayed.body).toEqual(first.body)
        }),
      ),
  },
  {
    name: "refuses a malformed durable-min-version with InvalidInput",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`

          for (const malformed of ["", "01", "-1", "1.5", "0x10"]) {
            const reply = yield* count(server, token, "malformed", malformed)
            expect(reply.status).toBe(400)
            expect(reply.body).toMatchObject({
              reason: {
                _tag: "InvalidInput",
                code: "decode",
                issues: [{ path: "durable-min-version" }],
              },
            })
          }
        }),
      ),
  },
  {
    name: "reads the replica once it has replayed the caller's version, falls through to the primary while it lags, and serves tokenless reads there",
    requiresReplica: true,
    timeoutMs: 60_000,
    run: async ({ expect, environment }) => {
      const replica = environment.replica!

      await withReplica(
        environment,
        replica.database,
        Effect.gen(function* () {
          const control = yield* replica.connect
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`

          const own = (yield* post(server, token, "lag")).headers.get("durable-version")!
          yield* replayedThrough(control, own)
          yield* pauseReplay(control)

          // Another writer commits without the caller seeing its version.
          const other = (yield* post(server, token, "lag")).headers.get("durable-version")!

          // The replica has the caller's write, so it answers, without the other one.
          expect(yield* count(server, token, "lag", own)).toMatchObject({ status: 200, body: 1 })
          expect(yield* count(server, token, "lag")).toMatchObject({ status: 200, body: 1 })

          // It is behind the other write's version, so the primary answers.
          expect(yield* count(server, token, "lag", other)).toMatchObject({ status: 200, body: 2 })

          yield* resumeReplay(control)
          yield* replayedThrough(control, other)
          expect(yield* count(server, token, "lag", other)).toMatchObject({ status: 200, body: 2 })
          expect(yield* count(server, token, "lag")).toMatchObject({ status: 200, body: 2 })
        }),
      )
    },
  },
  {
    name: "falls through to the primary when the replica cannot be reached",
    requiresReplica: true,
    run: async ({ expect, environment }) => {
      const url = new URL(Redacted.value(environment.replica!.database))
      // Nothing listens on port 1, so every replica connection is refused.
      url.port = "1"

      await withReplica(
        environment,
        Redacted.make(url.href),
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`

          const version = (yield* post(server, token, "down")).headers.get("durable-version")!

          expect(yield* count(server, token, "down", version)).toMatchObject({
            status: 200,
            body: 1,
          })
          expect(yield* count(server, token, "down")).toMatchObject({ status: 200, body: 1 })
        }),
      )
    },
  },
  {
    name: "the Promise client reads its own writes while the replica lags, sending the greatest version it was issued",
    requiresReplica: true,
    timeoutMs: 60_000,
    run: async ({ expect, environment }) => {
      const replica = environment.replica!

      await withReplica(
        environment,
        replica.database,
        Effect.gen(function* () {
          const control = yield* replica.connect
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const sent: Array<Headers> = []
          const issued: Array<string | null> = []

          const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            sent.push(new Headers(init?.headers))

            return globalThis.fetch(input, init).then((response) => {
              issued.push(response.headers.get("durable-version"))

              return response
            })
          }

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch,
          })
          const room = rooms.get("client")

          yield* Effect.promise(() => room.Post({ text: "a" }))
          yield* replayedThrough(control, issued.at(-1)!)
          yield* pauseReplay(control)
          yield* Effect.promise(() => room.Post({ text: "b" }))
          const latest = issued.at(-1)!

          // The paused replica holds only the first write; the client's query falls through.
          expect(yield* count(server, `${tenant}:alice`, "client")).toMatchObject({ body: 1 })
          expect(yield* Effect.promise(() => room.Count())).toBe(2)
          expect(sent.at(-1)!.get("durable-min-version")).toBe(latest)
          expect(VERSION.test(latest)).toBe(true)
        }),
      )
    },
  },
  {
    name: "an in-process handle's query reads the commands its runtime sent while the replica lags",
    requiresReplica: true,
    timeoutMs: 60_000,
    run: async ({ expect, environment }) => {
      const replica = environment.replica!

      await withReplica(
        environment,
        replica.database,
        Effect.gen(function* () {
          const control = yield* replica.connect
          const room = yield* HttpRoom.get("in-process")

          yield* room.Post({ text: "a" }).pipe(Effect.orDie)
          yield* pauseReplay(control)
          yield* room.Post({ text: "b" }).pipe(Effect.orDie)

          expect(yield* room.Count().pipe(Effect.orDie)).toBe(2)
        }),
      )
    },
  },
]
