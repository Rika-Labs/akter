import { CellUsageLive } from "@akter/metering"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { defaultPricingConfig } from "@akter/billing"
import { Actor, Anonymous, ASSERTION_HEADER, ConnectionLimitExceeded } from "@rikalabs/akter"
import { Actors, Auth } from "@rikalabs/akter/runtime"
import { ActorTest } from "@rikalabs/akter/testing"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { Headers, HttpClient, FetchHttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { createDatabase, type FixtureEdge, startEdge } from "../fixtures.ts"

const harness = ManagedRuntime.make(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer))

afterAll(() => harness.dispose())

const decodeRefusal = (body: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ reason: ConnectionLimitExceeded })))(
    body,
  ).pipe(
    Effect.map(({ reason }) => reason),
    Effect.orDie,
  )

const Probe = Actor.make("JournalProbe", {
  key: Schema.String,
  api: {
    Ping: Actor.command("Ping", { payload: Schema.Struct({}), success: Schema.Int }),
    Get: Actor.query("Get", { payload: Schema.Struct({}), success: Schema.Int, watch: true }),
    Count: Actor.stream("Count", { payload: Schema.Finite, success: Schema.Finite }),
  },
})

const Singleton = Actor.make("SingletonJournalProbe", {
  key: Actor.singleton,
  api: {
    Ping: Actor.command("Ping", { payload: Schema.Struct({}), success: Schema.Int }),
    Get: Actor.query("Get", { payload: Schema.Struct({}), success: Schema.Int }),
  },
})

/**
 * A real runner with the cell usage journal behind `edge`. Its provider is a
 * hosted assertion provider that also admits callers without an assertion as
 * anonymous, so anonymous requests reach the runtime's own refusals instead of
 * stopping at `missing_credentials`.
 */
const serveCell = Effect.fnUntraced(function* (edge: FixtureEdge) {
  const cellUrl = Redacted.make(yield* createDatabase("journal"))
  const cell = yield* Layer.build(
    CellUsageLive({ deploymentId: edge.deployment }).pipe(
      Layer.provideMerge(PgClient.layer({ url: cellUrl, maxConnections: 3 })),
    ),
  )
  const runtime = yield* Layer.build(
    ActorTest.layer({
      database: cellUrl,
      maxConnections: 3,
      authorize: () => Effect.succeed(true),
    }).pipe(Layer.provide(Layer.succeedContext(cell))),
  )
  const hosted = Auth.assertion({
    issuer: edge.issuer,
    audience: edge.deployment,
    region: "r1",
    keys: edge.keys,
  })
  const serving = Actors.serve({
    actors: [Probe, Singleton],
    auth: {
      ...hosted,
      authenticate: (request) =>
        Headers.has(request.headers, ASSERTION_HEADER)
          ? hosted.authenticate(request)
          : Effect.succeed({ caller: Anonymous.make({}), tenant: "default" }),
    },
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Probe.toLayer(
          Effect.succeed({
            Ping: () => Effect.succeed(23),
            Count: (count: number) => Stream.range(1, count),
          }),
        ),
        Probe.toQueryLayer(Effect.succeed({ Get: () => Effect.succeed(17) })),
        Singleton.toLayer(Effect.succeed({ Ping: () => Effect.succeed(23) })),
        Singleton.toQueryLayer(Effect.succeed({ Get: () => Effect.succeed(17) })),
      ),
    ),
    Layer.provide(Layer.succeedContext(runtime)),
    Layer.provide(FetchHttpClient.layer),
  )
  const web = HttpRouter.toWebHandler(serving, { disableLogger: true })
  const runner = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) }),
    ),
    (server) =>
      Effect.promise(() => server.stop(true)).pipe(
        Effect.andThen(Effect.promise(() => web.dispose())),
      ),
  )

  yield* edge.addRunner({ region: "r1", url: `http://127.0.0.1:${runner.port}` })

  return Context.get(cell, SqlClient.SqlClient)
})

describe("edge to cell usage journal", () => {
  it(
    "records a command only once and correlates each signed read token to its exact edge reservation",
    () =>
      harness.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const edge = yield* startEdge({ primaryRegion: "r1", plan: "free" })
            const key = yield* edge.issueApiKey({ tenant: "acme", subject: "reader" })
            const sql = yield* serveCell(edge)

            const client = yield* HttpClient.HttpClient
            const minted = yield* client.execute(
              HttpClientRequest.post(`${edge.url}/command-ids`, {
                headers: { authorization: `Bearer ${key}` },
              }),
            )
            const { commandId } = yield* minted.json.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String })),
              ),
            )
            const call = (member: string, cid?: string) => {
              const request = HttpClientRequest.post(
                `${edge.url}/actors/JournalProbe/p-1/${member}`,
                {
                  headers:
                    cid === undefined
                      ? { authorization: `Bearer ${key}` }
                      : { authorization: `Bearer ${key}`, "idempotency-key": cid },
                },
              )

              return client
                .execute(HttpClientRequest.bodyText(request, "{}", "application/json"))
                .pipe(
                  Effect.flatMap((response) =>
                    Effect.map(response.text, (body) => ({ status: response.status, body })),
                  ),
                )
            }

            expect(yield* call("Ping", commandId)).toEqual({ status: 200, body: "23" })
            expect(yield* call("Ping", commandId)).toEqual({ status: 200, body: "23" })
            expect(yield* call("Get")).toEqual({ status: 200, body: "17" })
            expect(yield* call("Get")).toEqual({ status: 200, body: "17" })

            const journal = yield* sql<{
              readonly kind: string
              readonly tenant: string
              readonly actorType: string
              readonly actorId: string
              readonly commandId: string | null
              readonly requestToken: string | null
            }>`SELECT kind, tenant_id AS tenant, actor_type AS "actorType", actor_id AS "actorId",
            command_id AS "commandId", request_token AS "requestToken"
            FROM cloud_meter_cell_journal ORDER BY kind, request_token`
            const reserved = yield* edge.sql<{ readonly kind: string; readonly commandId: string }>`
            SELECT kind, command_id AS "commandId" FROM cloud_usage_reservation ORDER BY kind, command_id`

            expect(journal).toHaveLength(3)
            expect(reserved).toHaveLength(3)
            expect(
              journal.map(({ kind, commandId: cid, requestToken }) => ({
                kind,
                commandId: cid ?? requestToken,
              })),
            ).toEqual(reserved)

            for (const row of journal)
              expect(row).toMatchObject({
                tenant: "acme",
                actorType: "JournalProbe",
                actorId: "p-1",
              })

            const [account] = yield* edge.sql<{ readonly units: number }>`
            SELECT reserved_units::int AS units FROM cloud_usage_account
            WHERE organization_id = ${edge.organizationId}`

            expect(account?.units).toBe(7)

            const rejectedQuery = yield* call("Get", "keyed-query")
            const rejectedWatch = yield* call("Get/watch", "keyed-watch")

            for (const response of [rejectedQuery, rejectedWatch]) {
              expect(response.status).toBe(400)
              expect(response.body).toBe(
                '{"_tag":"ActorError","reason":{"_tag":"InvalidInput","code":"decode","issues":[{"path":"idempotency-key","message":"Hosted queries, watches and streams do not accept command identities"}]},"isRetryable":false}',
              )
            }

            const [heldAfterRejection] = yield* edge.sql<{ readonly units: number }>`
              SELECT reserved_units::int AS units FROM cloud_usage_account
              WHERE organization_id = ${edge.organizationId}`

            expect(heldAfterRejection?.units).toBe(7)

            yield* edge.sql`UPDATE cloud_usage_account SET command_units = 4999993
              WHERE organization_id = ${edge.organizationId}`

            const capReplay = yield* call("Get", commandId)

            expect(capReplay.status).toBe(400)
            expect(capReplay.body).toBe(rejectedQuery.body)

            const [unchanged] = yield* sql<{
              readonly n: number
            }>`SELECT count(*)::int AS n FROM cloud_meter_cell_journal`

            expect(unchanged?.n).toBe(3)

            yield* edge.sql`UPDATE cloud_usage_account SET command_units = 0
              WHERE organization_id = ${edge.organizationId}`

            const singletonRequest = HttpClientRequest.post(
              `${edge.url}/actors/SingletonJournalProbe/Ping`,
              {
                headers: { authorization: `Bearer ${key}`, "idempotency-key": commandId },
              },
            )
            const singletonCommand = yield* client.execute(
              HttpClientRequest.bodyText(singletonRequest, "{}", "application/json"),
            )

            expect(singletonCommand.status).toBe(200)
            expect(yield* singletonCommand.text).toBe("23")

            const singletonRead = yield* client.execute(
              HttpClientRequest.bodyText(
                HttpClientRequest.post(`${edge.url}/actors/SingletonJournalProbe/Get`, {
                  headers: { authorization: `Bearer ${key}` },
                }),
                "{}",
                "application/json",
              ),
            )

            expect(singletonRead.status).toBe(200)

            expect(yield* singletonRead.text).toBe("17")

            const singletonRows = yield* sql<{
              readonly kind: string
              readonly actorId: string
              readonly token: string | null
            }>`
              SELECT kind, actor_id AS "actorId", request_token AS token FROM cloud_meter_cell_journal
              WHERE actor_type = 'SingletonJournalProbe' ORDER BY kind`
            const singletonReservations = yield* edge.sql<{
              readonly kind: string
              readonly actorId: string
              readonly commandId: string
            }>`
              SELECT kind, actor_id AS "actorId", command_id AS "commandId" FROM cloud_usage_reservation
              WHERE actor_type = 'SingletonJournalProbe' ORDER BY kind`

            expect(singletonRows).toHaveLength(2)
            expect(singletonReservations).toHaveLength(2)
            expect(singletonRows.map(({ actorId }) => actorId)).toEqual(["singleton", "singleton"])
            expect(singletonReservations.map(({ actorId }) => actorId)).toEqual([
              "singleton",
              "singleton",
            ])
            expect(singletonRows[1]?.token).toBe(singletonReservations[1]?.commandId)
          }),
        ),
      ),
    90_000,
  )

  it(
    "leaves no usage for keyed queries and streams or a watch refused at the connection cap, and meters a watch under it",
    () =>
      harness.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const edge = yield* startEdge({
              primaryRegion: "r1",
              plan: "free",
              pricing: {
                ...defaultPricingConfig,
                tiers: defaultPricingConfig.tiers.map((tier) =>
                  tier.id === "free" ? { ...tier, concurrentConnections: 1 } : tier,
                ),
              },
            })
            const key = yield* edge.issueApiKey({ tenant: "acme", subject: "reader" })
            const sql = yield* serveCell(edge)
            const client = yield* HttpClient.HttpClient
            const request = (path: string, headers: Record<string, string>, body = "{}") =>
              HttpClientRequest.bodyText(
                HttpClientRequest.post(`${edge.url}/actors/${path}`, { headers }),
                body,
                "application/json",
              )

            const post = (path: string, headers: Record<string, string>, body = "{}") =>
              client
                .execute(request(`JournalProbe/p-1/${path}`, headers, body))
                .pipe(
                  Effect.flatMap((response) =>
                    Effect.map(response.text, (text) => ({ status: response.status, body: text })),
                  ),
                )

            const usage = Effect.gen(function* () {
              const [journal] = yield* sql<{ readonly n: number }>`
                SELECT count(*)::int AS n FROM cloud_meter_cell_journal`
              const [account] = yield* edge.sql<{ readonly reserved: number }>`
                SELECT COALESCE(sum(reserved_units), 0)::int AS reserved FROM cloud_usage_account
                WHERE organization_id = ${edge.organizationId}`
              const held = yield* edge.sql<{ readonly kind: string; readonly commandId: string }>`
                SELECT kind, command_id AS "commandId" FROM cloud_usage_reservation
                WHERE state = 'reserved' ORDER BY reserved_at`
              const [leases] = yield* edge.sql<{ readonly n: number }>`
                SELECT count(*)::int AS n FROM cloud_connection_lease`

              return {
                journal: journal?.n,
                reserved: account?.reserved,
                held,
                leases: leases?.n,
              }
            })

            const minted = yield* client.execute(
              HttpClientRequest.post(`${edge.url}/command-ids`, {
                headers: { authorization: `Bearer ${key}` },
              }),
            )
            const { commandId } = yield* minted.json.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String })),
              ),
            )

            expect(
              yield* post("Ping", { authorization: `Bearer ${key}`, "idempotency-key": commandId }),
            ).toEqual({ status: 200, body: "23" })

            const created = yield* usage

            expect(created).toEqual({
              journal: 1,
              reserved: 5,
              held: [{ kind: "command", commandId }],
              leases: 0,
            })

            const refused =
              '{"_tag":"ActorError","reason":{"_tag":"InvalidInput","code":"decode","issues":[{"path":"idempotency-key","message":"Hosted queries, watches and streams do not accept command identities"}]},"isRetryable":false}'

            expect(yield* post("Get", { "idempotency-key": "anonymous-query" })).toEqual({
              status: 400,
              body: refused,
            })
            expect(
              yield* post(
                "Count",
                { authorization: `Bearer ${key}`, "idempotency-key": "keyed-stream" },
                "2",
              ),
            ).toEqual({ status: 400, body: refused })
            expect(
              yield* post("Get/watch", {
                authorization: `Bearer ${key}`,
                "idempotency-key": "keyed-watch",
              }),
            ).toEqual({ status: 400, body: refused })
            const unwatchable = yield* client.execute(
              request("SingletonJournalProbe/Get/watch", { authorization: `Bearer ${key}` }),
            )

            expect(unwatchable.status).toBe(400)
            expect(yield* usage).toEqual(created)

            const opened = yield* Deferred.make<{
              readonly status: number
              readonly type: string
              readonly first: string
            }>()
            const watching = yield* client
              .execute(request("JournalProbe/p-1/Get/watch", { authorization: `Bearer ${key}` }))
              .pipe(
                Effect.flatMap((response) =>
                  response.stream.pipe(
                    Stream.runForEach((chunk) =>
                      Deferred.succeed(opened, {
                        status: response.status,
                        type: response.headers["content-type"] ?? "",
                        first: new TextDecoder().decode(chunk),
                      }),
                    ),
                  ),
                ),
                Effect.forkScoped,
              )
            const watch = yield* Deferred.await(opened)

            expect(watch.status).toBe(200)
            expect(watch.type).toContain("text/event-stream")
            expect(watch.first).toContain("17")

            const metered = yield* usage

            expect(metered).toMatchObject({ journal: 2, reserved: 6, leases: 1 })
            expect(metered.held.map(({ kind }) => kind)).toEqual(["command", "read"])

            const [token] = yield* sql<{ readonly token: string }>`
              SELECT request_token AS token FROM cloud_meter_cell_journal WHERE kind = 'read'`

            expect(token?.token).toBe(metered.held[1]?.commandId)

            const capped = yield* post("Get/watch", { authorization: `Bearer ${key}` })

            expect(capped.status).toBe(429)
            expect(yield* decodeRefusal(capped.body)).toEqual(
              ConnectionLimitExceeded.make({
                organizationId: edge.organizationId,
                kind: "sse",
                limit: 1,
                open: 1,
              }),
            )
            expect(yield* usage).toEqual(metered)

            yield* Fiber.interrupt(watching)

            const released = yield* usage.pipe(
              Effect.filterOrFail(({ leases }) => leases === 0),
              Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
              Effect.orDie,
            )

            expect(released).toEqual({ ...metered, leases: 0 })
          }),
        ),
      ),
    90_000,
  )
})
