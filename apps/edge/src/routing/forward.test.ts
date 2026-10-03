import { CellUsageLive } from "@akter/metering"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Actor } from "@rikalabs/akter"
import { Actors, Auth } from "@rikalabs/akter/runtime"
import { ActorTest } from "@rikalabs/akter/testing"
import { Context, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { HttpClient, FetchHttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { createDatabase, startEdge } from "../fixtures.ts"

const harness = ManagedRuntime.make(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer))

afterAll(() => harness.dispose())

const Probe = Actor.make("JournalProbe", {
  key: Schema.String,
  api: {
    Ping: Actor.command("Ping", { payload: Schema.Struct({}), success: Schema.Int }),
    Get: Actor.query("Get", { payload: Schema.Struct({}), success: Schema.Int, watch: true }),
  },
})

const Singleton = Actor.make("SingletonJournalProbe", {
  key: Actor.singleton,
  api: {
    Ping: Actor.command("Ping", { payload: Schema.Struct({}), success: Schema.Int }),
    Get: Actor.query("Get", { payload: Schema.Struct({}), success: Schema.Int }),
  },
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
            const cellUrl = Redacted.make(yield* createDatabase("journal"))
            const accounting = CellUsageLive({ deploymentId: edge.deployment }).pipe(
              Layer.provideMerge(PgClient.layer({ url: cellUrl, maxConnections: 3 })),
            )
            const cell = yield* Layer.build(accounting)
            const runtime = yield* Layer.build(
              ActorTest.layer({
                database: cellUrl,
                maxConnections: 3,
                authorize: () => Effect.succeed(true),
              }).pipe(Layer.provide(Layer.succeedContext(cell))),
            )
            const serving = Actors.serve({
              actors: [Probe, Singleton],
              auth: Auth.assertion({
                issuer: edge.issuer,
                audience: edge.deployment,
                region: "r1",
                keys: edge.keys,
              }),
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Probe.toLayer(Effect.succeed({ Ping: () => Effect.succeed(23) })),
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
                Bun.serve({
                  hostname: "127.0.0.1",
                  port: 0,
                  fetch: (request) => web.handler(request),
                }),
              ),
              (server) =>
                Effect.promise(() => server.stop(true)).pipe(
                  Effect.andThen(Effect.promise(() => web.dispose())),
                ),
            )

            yield* edge.addRunner({ region: "r1", url: `http://127.0.0.1:${runner.port}` })

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

            const sql = Context.get(cell, SqlClient.SqlClient)
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
                '{"_tag":"ActorError","reason":{"_tag":"InvalidInput","code":"decode","issues":[{"path":"idempotency-key","message":"Hosted queries and watches do not accept command identities"}]},"isRetryable":false}',
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
})
