import { index, pgTable, text } from "drizzle-orm/pg-core"
import {
  Cause,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect"
import { FetchHttpClient, Headers as HttpHeaders, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { retryPoolRefusal } from "../../../../packages/akter/src/runtime/database/bounded.ts"
import { Actor, Tenant, User } from "../../../../packages/akter/src/index.ts"
import { InternalActors } from "../../../../packages/akter/src/runtime/actors.ts"
import {
  ActorError,
  InvalidInput,
  NotCreated,
  RunnerAtCapacity,
  SessionEnded,
  Unauthorized,
} from "../../../../packages/akter/src/errors/actor.ts"
import type { ActorRef } from "../../../../packages/akter/src/identity/caller.ts"
import { ActorTest } from "../../../../packages/akter/src/testing/actor-test.ts"
import { clusterLayer, ActorCluster } from "../cluster.ts"
import type { Authenticated } from "../../../../packages/akter/src/serve/auth.ts"
import { HttpWatched, serveHttp, tenantOf, httpSuite } from "./http.ts"
import { pauseReplay, replayedThrough, withReplica } from "./read-your-writes.ts"
import type { Server } from "./http.ts"
import { preparedForRowLevelSecurity } from "./rls.ts"
import type { ConformanceCase, ConformanceEnvironment, ConformanceSuite } from "../conformance.ts"
import { Auth } from "../../../../packages/akter/src/runtime/index.ts"

const Said = Actor.event("Said", { text: Schema.String })

const Aside = Actor.event("Aside", {})

/** The one owned table of `Gauge`, created by `watchLayer` when it is missing. */
export const watchRows = Actor.table(
  pgTable(
    "conformance_watch_rows",
    { id: text("id").primaryKey(), label: text("label").notNull() },
    (table) => [index("conformance_watch_rows_label").on(table.label)],
  ),
)

/** What drizzle-kit generates for `watchRows`; `owned.test.ts` checks it stays so. */
export const watchDdl = [
  `CREATE TABLE "conformance_watch_rows" (
	"routing_key" bigint,
	"tenant_id" text,
	"actor_id" text,
	"id" text,
	"label" text NOT NULL,
	CONSTRAINT "conformance_watch_rows_pkey" PRIMARY KEY("routing_key","tenant_id","actor_id","id")
);
`,
  `ALTER TABLE "conformance_watch_rows" ENABLE ROW LEVEL SECURITY;`,
  `CREATE INDEX "conformance_watch_rows_label" ON "conformance_watch_rows" ("routing_key","tenant_id","actor_id","label");`,
  `CREATE POLICY "durable_tenant" ON "conformance_watch_rows" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('durable.tenant', true)) WITH CHECK (tenant_id = current_setting('durable.tenant', true));`,
]

const stash = Actor.blob("watch-stash")

export interface WatchFixture {
  /** How many times each watched query's handler has run. */
  runs: Map<string, number>
  /** Waited on by the `Gated` query after it reads state, so a test can hold a rerun open. */
  gate: Effect.Effect<void>
}

export const watchFixture = (): WatchFixture => ({ runs: new Map(), gate: Effect.void })

const Bump = Actor.command("Bump", { payload: Schema.Finite })

const Say = Actor.command("Say", { payload: Schema.String })

const Glance = Actor.command("Glance")

const Label = Actor.command("Label", { payload: Schema.String })

const Store = Actor.command("Store", { payload: Schema.String })

const Idle = Actor.command("Idle")

const Total = Actor.query("Total", { success: Schema.Finite, watch: true })

const Gated = Actor.query("Gated", { success: Schema.Finite, watch: true })

const Sayings = Actor.query("Sayings", { success: Schema.Array(Schema.String), watch: true })

const Retained = Actor.query("Retained", { success: Schema.Int, watch: true })

const Labels = Actor.query("Labels", { success: Schema.Array(Schema.String), watch: true })

const Stored = Actor.query("Stored", { success: Schema.String, watch: true })

const Asides = Actor.query("Asides", { success: Schema.Int, watch: true })

const Grouped = Actor.query("Grouped", { success: Schema.Int, watch: true })

const Plain = Actor.query("Plain", { success: Schema.Finite })

const Flood = Actor.stream("Flood", { success: Schema.Finite })

const gaugeState = Actor.state({
  count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

/** Every kind of read a watch records, over state, one event class, one table, and one blob. */
const Gauge = Actor.make("WatchGauge", {
  key: Schema.String,
  state: gaugeState,
  events: [Said, Aside],
  tables: [watchRows],
  blobs: [stash],
  api: {
    Bump,
    Say,
    Glance,
    Label,
    Store,
    Idle,
    Total,
    Gated,
    Sayings,
    Retained,
    Labels,
    Stored,
    Asides,
    Grouped,
    Plain,
    Flood,
  },
  policy: {
    hibernateAfter: "1 second",
    keepEvents: "5 seconds",
    watch: { minInterval: "10 millis", reconcileEvery: "5 seconds" },
  },
})

const texts = new TextEncoder()

const decoded = new TextDecoder()

const GaugeLive = Gauge.toLayer(
  Effect.succeed({
    Bump: Effect.fnUntraced(function* (by: number) {
      const turn = yield* Gauge.Turn
      yield* turn.state.set({ count: turn.state.count + by })
    }),
    Say: Effect.fnUntraced(function* (text: string) {
      yield* (yield* Gauge.Turn).emit(Said.make({ text }))
    }),
    Glance: Effect.fnUntraced(function* () {
      yield* (yield* Gauge.Turn).emit(Aside.make({}))
    }),
    Label: Effect.fnUntraced(function* (label: string) {
      yield* (yield* Gauge.Turn).rows(watchRows).insert({ id: label, label })
    }),
    Store: Effect.fnUntraced(function* (text: string) {
      yield* (yield* Gauge.Turn).blob(stash).set("box", texts.encode(text))
    }),
    Idle: () => Effect.void,
    Flood: () => Stream.iterate(0, (value) => value + 1),
  }),
)

const GaugeReads = (fixture: WatchFixture) => {
  const ran = (query: string) =>
    Effect.sync(() => fixture.runs.set(query, (fixture.runs.get(query) ?? 0) + 1))

  return Gauge.toQueryLayer(
    Effect.succeed({
      Total: Effect.fnUntraced(function* () {
        yield* ran("Total")

        return (yield* Gauge.Read).state.count
      }),
      Gated: Effect.fnUntraced(function* () {
        yield* ran("Gated")
        const count = (yield* Gauge.Read).state.count
        yield* Effect.suspend(() => fixture.gate)

        return count
      }),
      Sayings: Effect.fnUntraced(function* () {
        yield* ran("Sayings")
        const said = yield* (yield* Gauge.Read).events(Said).pipe(Effect.orDie)

        return said.map(({ event }) => event.text)
      }),
      Retained: Effect.fnUntraced(function* () {
        yield* ran("Retained")

        return yield* (yield* Gauge.Read).events(Said).pipe(
          Effect.map((said) => said.length),
          Effect.orElseSucceed(() => -1),
        )
      }),
      Labels: Effect.fnUntraced(function* () {
        yield* ran("Labels")
        const found = yield* (yield* Gauge.Read).rows(watchRows).all({ orderBy: { id: "asc" } })

        return found.map(({ label }) => label)
      }),
      Stored: Effect.fnUntraced(function* () {
        yield* ran("Stored")
        const found = yield* (yield* Gauge.Read).blob(stash).get("box")

        return Option.match(found, { onNone: () => "", onSome: (bytes) => decoded.decode(bytes) })
      }),
      Asides: Effect.fnUntraced(function* () {
        yield* ran("Asides")

        return (yield* (yield* Gauge.Read).events(Aside).pipe(Effect.orDie)).length
      }),
      Grouped: Effect.fnUntraced(function* () {
        yield* ran("Grouped")

        const found = yield* (yield* Gauge.Read).group((db) =>
          db.select({ id: watchRows.id }).from(watchRows),
        )

        return found.length
      }),
      Plain: Effect.fnUntraced(function* () {
        return (yield* Gauge.Read).state.count
      }),
    }),
  )
}

const Mirror = Actor.make("WatchMirror", {
  key: Schema.String,
  state: gaugeState,
  api: { Bump, Total },
  policy: {
    reauthorizeEvery: "2 seconds",
    watch: { minInterval: "10 millis", reconcileEvery: "5 seconds" },
  },
})

/** A state-only actor, so a replica can answer its watch and a cluster builds it without a database table. */
export const mirrorLayer = Layer.mergeAll(
  Mirror.toLayer(
    Effect.succeed({
      Bump: Effect.fnUntraced(function* (by: number) {
        const turn = yield* Mirror.Turn
        yield* turn.state.set({ count: turn.state.count + by })
      }),
    }),
  ),
  Mirror.toQueryLayer(
    Effect.succeed({
      Total: Effect.fnUntraced(function* () {
        return (yield* Mirror.Read).state.count
      }),
    }),
  ),
)

const Capped = Actor.make("WatchCapped", {
  key: Schema.String,
  state: gaugeState,
  api: { Bump, Total },
  policy: { watch: { maxPerActor: 3 } },
})

const cappedLayer = Layer.mergeAll(
  Capped.toLayer(
    Effect.succeed({
      Bump: Effect.fnUntraced(function* (by: number) {
        const turn = yield* Capped.Turn
        yield* turn.state.set({ count: turn.state.count + by })
      }),
    }),
  ),
  Capped.toQueryLayer(
    Effect.succeed({
      Total: Effect.fnUntraced(function* () {
        return (yield* Capped.Read).state.count
      }),
    }),
  ),
)

/** Applies the drizzle-kit DDL of `watchRows` once, then registers the actor types of this file. */
export const watchLayer = (fixture: WatchFixture) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const existing = yield* retryPoolRefusal(sql<{ relname: string }>`
        SELECT relname FROM pg_class WHERE relname = 'conformance_watch_rows'`)

      if (existing.length === 0)
        for (const statement of watchDdl) yield* retryPoolRefusal(sql.unsafe(statement))

      return Layer.mergeAll(GaugeLive, GaugeReads(fixture), mirrorLayer, cappedLayer, unsafeLayer)
    }).pipe(Effect.orDie),
  )

const WAIT = "20 seconds"

/**
 * A watch read by a child fiber: `seen` fills as results arrive, `until(n)`
 * waits for the n-th, and `ended` joins to how the watch ended.
 */
const observe = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const seen: Array<A> = []

    const ended = yield* stream.pipe(
      Stream.runForEach((value) => Effect.sync(() => seen.push(value))),
      Effect.exit,
      Effect.forkChild,
    )

    const until = (count: number) =>
      Effect.sleep("25 millis").pipe(
        Effect.repeat({ until: () => seen.length >= count }),
        Effect.timeoutOrElse({
          duration: WAIT,
          orElse: () =>
            Effect.die(new Error(`Expected ${count} results, saw ${JSON.stringify(seen)}`)),
        }),
        Effect.asVoid,
      )

    const failure = Fiber.join(ended).pipe(
      Effect.timeoutOrElse({
        duration: WAIT,
        orElse: () => Effect.die(new Error("The watch did not end")),
      }),
      Effect.map((exit) =>
        Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
      ),
    )

    return { seen, until, ended, failure }
  })

const reasonOf = (error: ActorError | undefined) => error?.reason

/** Long enough for a rerun the watch should not make to have started. */
const QUIET = "400 millis"

const runsOf = (fixture: WatchFixture, query: string) => fixture.runs.get(query) ?? 0

const EXPIRATION_SECONDS = 3

const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: WatchFixture,
  runners: number,
  body: Effect.Effect<A, E, ActorCluster | Scope.Scope>,
  holdersOnly?: ReadonlyArray<number>,
) =>
  environment.run(
    Effect.gen(function* () {
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        clusterLayer({
          database,
          runners,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: watchLayer(fixture),
          as: User.make({ subject: "alice" }),
          authorize: () => Effect.succeed(true),
          holdersOnly,
        }),
      )

      return yield* body.pipe(Effect.scoped, Effect.provideContext(context))
    }),
  )

/** An actor id that `runner` owns, probed through runner 0. */
const ownedBy = (runner: number, prefix: string) =>
  Effect.gen(function* () {
    const cluster = yield* ActorCluster

    for (let index = 0; index < 200; index++) {
      const candidate: ActorRef = (yield* cluster.on(0)(Mirror.get(`${prefix}-${index}`))).ref

      if ((yield* cluster.owner(candidate)) === runner) return candidate
    }

    return yield* Effect.die(new Error(`Runner ${runner} owns no probed actor`))
  })

const Unsafe = Actor.make("WatchUnsafe", {
  key: Schema.String,
  state: gaugeState,
  api: { Bump, Total },
})

class Outside extends Context.Service<Outside, { readonly value: number }>()(
  "@akter/conformance/conformance/watch/Outside",
) {}

/** A watched handler that needs a service the types forbid, as code that got around them would. */
const unsafeLayer = Layer.mergeAll(
  Unsafe.toLayer(
    Effect.succeed({
      Bump: Effect.fnUntraced(function* (by: number) {
        const turn = yield* Unsafe.Turn
        yield* turn.state.set({ count: turn.state.count + by })
      }),
    }),
  ),
  Unsafe.toQueryLayer(
    Effect.succeed({
      Total: (() =>
        Effect.gen(function* () {
          return (yield* Unsafe.Read).state.count + (yield* Outside).value
        })) as never,
    }),
  ).pipe(Layer.provide(Layer.succeed(Outside, { value: 1 }))),
)

interface SseMessage {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

const decodeWireReason = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) }),
    }),
  ),
)

/** The reason tag and code a served error body or `end` message carries. */
const wireReason = (text: string) =>
  decodeWireReason(text).pipe(
    Effect.orDie,
    Effect.map(({ reason }) => ({ tag: reason._tag, code: reason.code })),
  )

/**
 * A served watch read over HTTP, as the Promise client reads one: SSE messages
 * parsed from the body, comments skipped, closed with the scope.
 */
const watchOver = (
  url: string,
  init: { readonly token: string; readonly headers?: Readonly<Record<string, string>> },
) =>
  Effect.gen(function* () {
    const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

    const response = yield* client
      .execute(
        HttpClientRequest.post(url, {
          headers: { authorization: `Bearer ${init.token}`, ...init.headers },
        }),
      )
      .pipe(Effect.orDie)

    const messages: Array<SseMessage> = []

    if (response.status !== 200)
      return { status: response.status, messages, until: () => Effect.void }

    let buffer = ""

    yield* response.stream.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          buffer += chunk
          let end = buffer.indexOf("\n\n")

          while (end !== -1) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            end = buffer.indexOf("\n\n")
            const fields = new Map<string, string>()

            for (const line of block.split("\n"))
              if (!line.startsWith(":")) {
                const colon = line.indexOf(":")
                fields.set(line.slice(0, colon), line.slice(colon + 2))
              }

            if (fields.has("data"))
              messages.push({
                id: fields.get("id"),
                event: fields.get("event"),
                data: fields.get("data")!,
              })
          }
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    )

    const until = (count: number) =>
      Effect.sleep("25 millis").pipe(
        Effect.repeat({ until: () => messages.length >= count }),
        Effect.timeoutOrElse({
          duration: WAIT,
          orElse: () =>
            Effect.die(new Error(`Expected ${count} messages, saw ${JSON.stringify(messages)}`)),
        }),
        Effect.asVoid,
      )

    return { status: 200, messages, until }
  })

const baseFetch = globalThis.fetch.bind(globalThis)

const VERSION = /^(0|[1-9]\d*)$/

const post = (
  server: { readonly send: Server["send"]; readonly mint: Server["mint"] },
  path: string,
  token: string,
) => Effect.flatMap(server.mint(), (key) => server.send(path, { token, key, body: { text: "a" } }))

/** `tenant:subject:expiresAtMs`, so a credential can expire while a watch is open. */
const expiring = Auth.make((request) =>
  Effect.gen(function* () {
    const header = Option.getOrUndefined(HttpHeaders.get(request.headers, "authorization")) ?? ""
    const match = /^Bearer ([^:]+):([^:]+):(\d+)$/.exec(header)

    if (match === null) return yield* Unauthorized.make({ code: "invalid_credentials" })

    const authenticated: Authenticated = {
      tenant: match[1]!,
      caller: User.make({ subject: match[2]! }),
      expiresAt: DateTime.makeUnsafe(Number(match[3])),
    }

    return authenticated
  }),
)

const servedCases: ReadonlyArray<ConformanceCase<WatchFixture>> = [
  {
    name: "serves a watch as server-sent events: the current result first, then one per change, each after the first carrying the version its rerun waited for",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`
          const base = `/actors/HttpWatched/served-events`

          const first = yield* post(server, `${base}/Post`, token)
          const watch = yield* watchOver(`${server.url}${base}/Level/watch`, { token })

          yield* watch.until(1)
          expect(watch.messages[0]).toEqual({ id: undefined, event: "result", data: "1" })

          const second = yield* post(server, `${base}/Post`, token)
          yield* watch.until(2)
          expect(watch.messages[1]).toEqual({
            id: second.headers.get("durable-version"),
            event: "result",
            data: "2",
          })
          expect(VERSION.test(watch.messages[1]!.id!)).toBe(true)
          expect(
            BigInt(watch.messages[1]!.id!) > BigInt(first.headers.get("durable-version")!),
          ).toBe(true)

          const resumed = yield* watchOver(`${server.url}${base}/Level/watch`, {
            token,
            headers: { "durable-min-version": second.headers.get("durable-version")! },
          })

          yield* resumed.until(1)
          expect(resumed.messages[0]).toEqual({
            id: second.headers.get("durable-version"),
            event: "result",
            data: "2",
          })
        }),
      ),
  },
  {
    name: "refuses a watch of a query without watch with 400 not_watchable, of an actor no command created with 404 NotCreated, and a malformed durable-min-version",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`
          yield* post(server, `/actors/HttpWatched/served-refused/Post`, token)

          const plain = yield* server.send("/actors/HttpWatched/served-refused/Count/watch", {
            token,
          })

          expect(plain.status).toBe(400)

          expect(yield* wireReason(plain.text)).toEqual({
            tag: "InvalidInput",
            code: "not_watchable",
          })

          const missing = yield* server.send("/actors/HttpWatched/served-missing/Level/watch", {
            token,
          })

          expect(missing.status).toBe(404)
          expect((yield* wireReason(missing.text)).tag).toBe("NotCreated")

          const malformed = yield* server.send("/actors/HttpWatched/served-refused/Level/watch", {
            token,
            headers: { "durable-min-version": "01" },
          })

          expect(malformed.status).toBe(400)

          const anonymous = yield* server.send("/actors/HttpWatched/served-refused/Level/watch", {})
          expect(anonymous.status).toBe(401)
        }),
      ),
  },
  {
    name: "denies a watch at open with 403, and ends a running one with access_denied within reauthorizeEvery after revocation",
    timeoutMs: 60_000,
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`
          const base = `/actors/HttpWatched/served-revoked`
          yield* post(server, `${base}/Post`, token)

          access.denied.add("Level")

          const denied = yield* server
            .send(`${base}/Level/watch`, { token })
            .pipe(Effect.ensuring(Effect.sync(() => access.denied.delete("Level"))))

          expect(denied.status).toBe(403)
          expect(yield* wireReason(denied.text)).toEqual({
            tag: "Unauthorized",
            code: "access_denied",
          })

          const watch = yield* watchOver(`${server.url}${base}/Level/watch`, { token })
          yield* watch.until(1)
          access.denied.add("Level")
          yield* test.advance("55 seconds")

          yield* watch
            .until(2)
            .pipe(Effect.ensuring(Effect.sync(() => access.denied.delete("Level"))))
          expect(watch.messages[1]?.event).toBe("end")
          expect(yield* wireReason(watch.messages[1]!.data)).toEqual({
            tag: "Unauthorized",
            code: "access_denied",
          })
        }),
      ),
  },
  {
    name: "ends a watch at its credential's expiry with Unauthorized expired, and sends no result after it",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ auth: expiring })
          const tenant = yield* tenantOf
          const base = `/actors/HttpWatched/served-expiry`
          const test = yield* ActorTest
          const now = DateTime.toEpochMillis(yield* test.now)
          const ttl = now + 60_000
          yield* post(server, `${base}/Post`, `${tenant}:alice:${ttl}`)

          const soon = `${tenant}:alice:${DateTime.toEpochMillis(yield* test.now) + 30_000}`
          const watch = yield* watchOver(`${server.url}${base}/Level/watch`, { token: soon })
          yield* watch.until(1)
          expect(watch.messages[0]?.event).toBe("result")

          yield* test.advance("31 seconds")
          yield* watch.until(2)
          expect(watch.messages[1]?.event).toBe("end")
          expect(yield* wireReason(watch.messages[1]!.data)).toEqual({
            tag: "Unauthorized",
            code: "expired",
          })

          yield* post(server, `${base}/Post`, `${tenant}:alice:${ttl}`)
          yield* Effect.sleep(QUIET)
          expect(watch.messages.length).toBe(2)
        }),
      ),
  },
  {
    name: "the Promise client watches a query, reopens a dropped connection with the greatest version it was sent, and ends with a typed error",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const base = `/actors/HttpWatched/served-client`
          yield* post(server, `${base}/Post`, token)

          const opened: Array<Headers> = []

          const cutting = (input: RequestInfo | URL, init?: RequestInit) =>
            baseFetch(input, init).then((response) => {
              opened.push(new Headers(init?.headers))

              if (opened.length > 1 || response.body === null) return response

              const source = response.body.getReader()
              let results = 0

              return new Response(
                new ReadableStream<Uint8Array>({
                  pull: (controller) =>
                    source.read().then((chunk) => {
                      if (chunk.done) return controller.close()

                      controller.enqueue(chunk.value)

                      results +=
                        new TextDecoder().decode(chunk.value).split("event: result").length - 1

                      if (results < 2) return undefined

                      controller.close()

                      return source.cancel()
                    }),
                }),
                { status: response.status, headers: response.headers },
              )
            })

          const room = HttpWatched.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${token}` },
            fetch: cutting,
          }).get("served-client")

          const iterator = room.Level.watch()[Symbol.asyncIterator]()
          const next = () => Effect.promise(() => iterator.next())

          expect((yield* next()).value).toBe(1)
          const second = yield* post(server, `${base}/Post`, token)
          expect((yield* next()).value).toBe(2)

          yield* post(server, `${base}/Post`, token)
          expect((yield* next()).value).toBe(3)
          expect(opened.length).toBe(2)
          expect(opened[0]!.get("durable-min-version")).toBe(null)
          expect(opened[1]!.get("durable-min-version")).toBe(second.headers.get("durable-version"))

          yield* Effect.promise(() => Promise.resolve(iterator.return?.()))
        }),
      ),
  },
]

export const watchConformance: ReadonlyArray<ConformanceCase<WatchFixture>> = [
  ...servedCases,
  {
    name: "sends the current result first, then a rerun after a turn that writes the state the query read",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-state")
          yield* gauge.Bump(2)
          const watch = yield* observe(gauge.Total.watch())

          yield* watch.until(1)
          expect(watch.seen).toEqual([2])

          yield* gauge.Bump(3)
          yield* watch.until(2)
          expect(watch.seen).toEqual([2, 5])
          expect(runsOf(fixture, "Total")).toBe(2)
        }),
      ),
  },
  {
    name: "sends a rerun after a turn that emits an event class the query read",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-event")
          yield* gauge.Say("one")
          const watch = yield* observe(gauge.Sayings.watch())

          yield* watch.until(1)
          yield* gauge.Say("two")
          yield* watch.until(2)
          expect(watch.seen).toEqual([["one"], ["one", "two"]])
        }),
      ),
  },
  {
    name: "sends a rerun after a turn that writes a table the query read",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-table")
          yield* gauge.Label("a")
          const watch = yield* observe(gauge.Labels.watch())

          yield* watch.until(1)
          yield* gauge.Label("b")
          yield* watch.until(2)
          expect(watch.seen).toEqual([["a"], ["a", "b"]])
        }),
      ),
  },
  {
    name: "sends a rerun after a turn that writes a blob the query read",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-blob")
          yield* gauge.Store("first")
          const watch = yield* observe(gauge.Stored.watch())

          yield* watch.until(1)
          yield* gauge.Store("second")
          yield* watch.until(2)
          expect(watch.seen).toEqual(["first", "second"])
        }),
      ),
  },
  {
    name: "does not send a result when the rerun is identical, and skips reruns for a turn that wrote nothing the query read",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-quiet")
          yield* gauge.Bump(1)
          const totals = yield* observe(gauge.Total.watch())
          const asides = yield* observe(gauge.Asides.watch())

          yield* totals.until(1)
          yield* asides.until(1)
          const totalRuns = runsOf(fixture, "Total")
          const asideRuns = runsOf(fixture, "Asides")

          yield* gauge.Bump(0)
          yield* gauge.Say("unread")
          yield* gauge.Label("unread")
          yield* gauge.Store("unread")
          yield* gauge.Idle()
          yield* Effect.sleep(QUIET)

          expect(runsOf(fixture, "Total")).toBe(totalRuns + 1)
          expect(totals.seen).toEqual([1])
          expect(runsOf(fixture, "Asides")).toBe(asideRuns)
          expect(asides.seen).toEqual([0])

          yield* gauge.Glance()
          yield* asides.until(2)
          expect(asides.seen).toEqual([0, 1])
        }),
      ),
  },
  {
    name: "coalesces commits that land during a rerun into one further rerun, and never sends a result reflecting an older version than an earlier one",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-coalesce")
          yield* gauge.Bump(0)
          const watch = yield* observe(gauge.Gated.watch())
          yield* watch.until(1)
          yield* gauge.Bump(1)
          yield* watch.until(2)
          const before = runsOf(fixture, "Gated")

          const release = yield* Deferred.make<void>()
          fixture.gate = Deferred.await(release)

          yield* gauge.Bump(1)
          yield* Effect.sleep(QUIET)
          yield* gauge.Bump(1)
          yield* gauge.Bump(1)
          yield* gauge.Bump(1)
          yield* Effect.sleep(QUIET)
          expect(runsOf(fixture, "Gated")).toBe(before + 1)

          fixture.gate = Effect.void
          yield* Deferred.succeed(release, undefined)
          yield* watch.until(4)
          yield* Effect.sleep(QUIET)

          expect(runsOf(fixture, "Gated")).toBe(before + 2)
          expect(watch.seen).toEqual([0, 1, 2, 5])
        }),
      ),
  },
  {
    name: "recovers a dropped Committed frame on the reconcile rerun",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const gauge = yield* Gauge.get("watch-dropped")
          yield* gauge.Bump(1)
          const watch = yield* observe(gauge.Total.watch())
          yield* watch.until(1)

          yield* test.dropCommitted(true)
          yield* gauge.Bump(1)
          yield* Effect.sleep(QUIET)
          expect(watch.seen).toEqual([1])

          yield* test.dropCommitted(false)
          yield* watch.until(2)
          expect(watch.seen).toEqual([1, 2])
        }),
      ),
  },
  {
    name: "recovers a retention prune of a read event class the same way",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const gauge = yield* Gauge.get("watch-pruned")
          yield* gauge.Say("old")
          const watch = yield* observe(gauge.Retained.watch())
          yield* watch.until(1)
          expect(watch.seen).toEqual([1])

          yield* test.advance("6 seconds")
          yield* test.cleanup
          yield* watch.until(2)
          expect(watch.seen).toEqual([1, -1])
        }),
      ),
  },
  {
    name: "ends a running watch that starts reading the placement group with not_watchable, as a defect in process",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-group")
          yield* gauge.Bump(1)
          const watch = yield* observe(gauge.Grouped.watch())

          const exit = yield* Fiber.join(watch.ended)
          expect(watch.seen).toEqual([])
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)

          const thrown = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          const reason = Schema.is(ActorError)(thrown) ? thrown.reason : undefined
          expect(Schema.is(InvalidInput)(reason) && reason.code).toBe("not_watchable")
        }),
      ),
  },
  {
    name: "refuses a watch of an actor no command has created with NotCreated, and creates none",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const gauge = yield* Gauge.get("watch-never-created")
          const ended = yield* gauge.Total.watch().pipe(Stream.runDrain, Effect.flip)

          expect(reasonOf(ended)).toEqual(NotCreated.make({}))
          expect((yield* test.inspect(gauge.ref)).generation).toBe(undefined)
        }),
      ),
  },
  {
    name: "denies a watch at open, ends it within reauthorizeEvery after revocation, and sends no result after the bound",
    timeoutMs: 60_000,
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const gauge = yield* Mirror.get("watch-revoked")
          yield* gauge.Bump(1)

          access.denied.add("Total")

          const refused = yield* gauge.Total.watch().pipe(
            Stream.runDrain,
            Effect.flip,
            Effect.ensuring(Effect.sync(() => access.denied.delete("Total"))),
          )

          expect(reasonOf(refused)).toEqual(Unauthorized.make({ code: "access_denied" }))

          const watch = yield* observe(gauge.Total.watch())
          yield* watch.until(1)
          access.denied.add("Total")
          yield* test.advance("1500 millis")

          const revoked = yield* watch.failure.pipe(
            Effect.ensuring(Effect.sync(() => access.denied.delete("Total"))),
          )

          expect(reasonOf(revoked)).toEqual(Unauthorized.make({ code: "access_denied" }))

          const late = yield* observe(gauge.Total.watch())
          yield* late.until(1)
          yield* test.advance("3 seconds")
          yield* gauge.Bump(1)

          const lapsed = yield* late.failure
          expect(reasonOf(lapsed)).toEqual(
            Unauthorized.make({ code: "reauthorization_unavailable" }),
          )
          expect(late.seen).toEqual([1])
        }),
      ),
  },
  {
    name: "keeps tenants apart: another tenant's caller cannot reach the actor's watch",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const mine = yield* Mirror.get("watch-tenants")
          yield* mine.Bump(4)

          const other = yield* Mirror.get("watch-tenants").pipe(
            Effect.provideService(Tenant, "watch-elsewhere"),
          )

          const refused = yield* other.Total.watch().pipe(Stream.runDrain, Effect.flip)
          expect(reasonOf(refused)).toEqual(NotCreated.make({}))

          const watch = yield* observe(mine.Total.watch())
          yield* watch.until(1)
          expect(watch.seen).toEqual([4])
        }),
      ),
  },
  {
    name: "an idle watch does not keep the actor resident, survives its hibernation, and does not count against the stream cap",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const gauge = yield* Gauge.get("watch-idle")
          yield* gauge.Bump(1)
          const watch = yield* observe(gauge.Total.watch())
          yield* watch.until(1)
          const generation = BigInt((yield* test.inspect(gauge.ref)).generation!)

          yield* test.hibernate(gauge.ref)
          yield* Effect.sleep(QUIET)
          yield* gauge.Bump(1)
          yield* watch.until(2)

          expect(BigInt((yield* test.inspect(gauge.ref)).generation!) > generation).toBe(true)
          expect(watch.seen).toEqual([1, 2])

          const floods = yield* Effect.forEach(
            Array.from({ length: 256 }),
            () => Effect.flatMap(Stream.toPull(gauge.Flood()), (pull) => pull),
            { concurrency: "unbounded" },
          )

          expect(floods.length).toBe(256)
        }),
      ),
  },
  {
    name: "a further watch past the per-actor cap answers RunnerAtCapacity",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const capped = yield* Capped.get("watch-capped")
          yield* capped.Bump(1)

          const open = yield* Effect.forEach(Array.from({ length: 3 }), () =>
            observe(capped.Total.watch()),
          )

          yield* Effect.forEach(open, (watch) => watch.until(1), { discard: true })

          const refused = yield* capped.Total.watch().pipe(Stream.runDrain, Effect.flip)
          expect(reasonOf(refused)).toEqual(RunnerAtCapacity.make({}))

          yield* Fiber.interrupt(open[0]!.ended)
          yield* Effect.sleep("300 millis")

          const replaced = yield* observe(capped.Total.watch())
          yield* replaced.until(1)
          expect(replaced.seen).toEqual([1])
        }),
      ),
  },
  {
    name: "a slow consumer receives the newest result and the watch stays open",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const gauge = yield* Gauge.get("watch-slow")
          yield* gauge.Bump(0)
          const pull = yield* Stream.toPull(gauge.Total.watch())
          const first = yield* pull.pipe(Effect.timeout(WAIT))
          expect([...first]).toEqual([0])

          for (const by of [1, 1, 1, 1, 1, 1]) {
            yield* gauge.Bump(by)
            yield* Effect.sleep("100 millis")
          }

          yield* Effect.sleep(QUIET)
          const newest = yield* pull.pipe(Effect.timeout(WAIT))
          expect([...newest]).toEqual([6])

          yield* gauge.Bump(1)
          const following = yield* pull.pipe(Effect.timeout(WAIT))
          expect([...following]).toEqual([7])
        }),
      ),
  },
  {
    name: "a handler that needs a service outside X.Read fails on its first rerun instead of running unwatched",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const unsafe = yield* Unsafe.get("watch-unsafe")
          yield* unsafe.Bump(1)
          const ended = yield* unsafe.Total.watch().pipe(Stream.runDrain, Effect.flip)

          const reason = reasonOf(ended)
          expect(Schema.is(SessionEnded)(reason) && reason.cause).toBe("Defect")
        }),
      ),
  },
  {
    name: "rerun waits for the frame's version: a lagging replica is bypassed and the primary answers",
    requiresReplica: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) => {
      const replica = environment.replica!

      return withReplica(
        environment,
        replica.database,
        Effect.gen(function* () {
          const control = yield* replica.connect
          const internal = yield* InternalActors
          const mirror = yield* Mirror.get("watch-replica")
          yield* mirror.Bump(1).pipe(Effect.orDie)
          yield* replayedThrough(control, internal.observedVersion()!)

          const watch = yield* observe(mirror.Total.watch())
          yield* watch.until(1)
          expect(watch.seen).toEqual([1])

          yield* pauseReplay(control)
          yield* mirror.Bump(1).pipe(Effect.orDie)
          yield* watch.until(2)
          expect(watch.seen).toEqual([1, 2])
        }),
      )
    },
  },
  {
    name: "with row-level security on, reruns run as the role bound to the tenant on whichever server answers",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { target, role } = yield* preparedForRowLevelSecurity(environment)

          if (!Redacted.isRedacted(target))
            return yield* Effect.die(new Error("The row-level security case needs Postgres"))

          const crypto = yield* Crypto.Crypto

          const context = yield* Layer.build(
            clusterLayer({
              database: target,
              runners: 2,
              shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
              actors: mirrorLayer,
              as: User.make({ subject: "alice" }),
              authorize: () => Effect.succeed(true),
              rowLevelSecurity: { role },
            }).pipe(Layer.provide(Layer.succeed(Crypto.Crypto, crypto))),
          )

          const cluster = Context.get(context, ActorCluster)
          yield* cluster.ready
          const tenant = yield* cluster.on(0)(ActorTest.use((test) => Effect.succeed(test.tenant)))
          const other = `${tenant}-b`

          const total = (scoped: string, runner: number, by: number) =>
            cluster.on(runner)(
              Effect.gen(function* () {
                const mirror = yield* Mirror.get("shared-id").pipe(Actor.tenant(scoped))
                yield* mirror.Bump(by)
              }),
            )

          yield* total(tenant, 0, 1)
          yield* total(other, 1, 10)

          const watchOf = (scoped: string, runner: number) =>
            cluster.on(runner)(
              Effect.gen(function* () {
                const mirror = yield* Mirror.get("shared-id").pipe(Actor.tenant(scoped))

                return yield* observe(mirror.Total.watch())
              }),
            )

          const mine = yield* watchOf(tenant, 0)
          const theirs = yield* watchOf(other, 1)
          yield* mine.until(1)
          yield* theirs.until(1)
          expect([mine.seen, theirs.seen]).toEqual([[1], [10]])

          yield* total(tenant, 1, 2)
          yield* mine.until(2)
          yield* Effect.sleep(QUIET)
          expect([mine.seen, theirs.seen]).toEqual([[1, 3], [10]])
        }).pipe(Effect.scoped),
      ),
  },
  {
    name: "a watch held on runner A sees a turn committed on runner B",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
        2,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const ref = yield* ownedBy(1, "watch-cross")
          const held = yield* cluster.on(0)(Mirror.get(ref.id))
          yield* cluster.on(0)(held.Bump(1))

          const watch = yield* observe(held.Total.watch()).pipe(cluster.on(0))
          yield* watch.until(1)

          const writer = yield* cluster.on(1)(Mirror.get(ref.id))
          yield* cluster.on(1)(writer.Bump(2))
          yield* watch.until(2)
          expect(watch.seen).toEqual([1, 3])
          expect(yield* cluster.owner(ref)).toBe(1)
        }),
      ),
  },
  {
    name: "reruns after an owner killed between commit and flush",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          const holder = cluster.on(0)
          const ref = yield* ownedBy(1, "watch-killed")
          const gauge = yield* holder(Mirror.get(ref.id))
          yield* holder(gauge.Bump(1))

          const watch = yield* observe(gauge.Total.watch()).pipe(holder)
          yield* watch.until(1)

          const owner = (yield* cluster.owner(ref))!

          const paused = yield* cluster.on(owner)(
            ActorTest.use((test) => test.pauseNext("beforeFlush")),
          )

          yield* holder(gauge.Bump(1)).pipe(
            Effect.ignore,
            Effect.forkChild({ startImmediately: true }),
          )
          yield* paused.reached
          yield* cluster.kill(owner)

          yield* watch.until(2)
          expect(watch.seen).toEqual([1, 2])
        }),
        [0],
      ),
  },
]

/** Watched actors, served beside the HTTP actors. */
export const watchSuite: ConformanceSuite<WatchFixture> = {
  fixture: watchFixture,
  layer: watchLayer,
  uses: [httpSuite],
}
