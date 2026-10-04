import {
  organizationCaps,
  type PlanId,
  type PricingConfig,
  PricingLive,
  type PricingTier,
} from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Actor,
  ActorError,
  ActorUnavailable,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  NotCreated,
  requestDigest,
  Timeout,
  Unauthorized,
} from "@rikalabs/akter"
import {
  ActorError as ClientActorError,
  ConnectionLimitExceeded as ClientConnectionLimitExceeded,
  QuotaExceeded as ClientQuotaExceeded,
  SpendLimitExceeded as ClientSpendLimitExceeded,
} from "@rikalabs/akter/client"
import { actorErrorBody, statusOf } from "@rikalabs/akter/runtime"
import {
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  Schedule,
  Schema,
  Scope,
} from "effect"
import { Base64Url } from "effect/encoding"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  type HttpMethod,
} from "effect/http"
import { SqlClient, type SqlError } from "effect/sql"
import { afterAll, describe, expect, it } from "vitest"
import { type FixtureEdge, type FixtureOptions, type Provisioned, startEdge } from "./fixtures.ts"
import {
  COMMAND_UNITS,
  ConnectionLimitExceeded,
  meteringOf,
  QuotaExceeded,
  quotaFailure,
  QuotaUnbound,
  quotas,
  SpendLimitExceeded,
  StorageQuotaExceeded,
} from "./quotas.ts"

const harness = ManagedRuntime.make(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer))

afterAll(() => harness.dispose())

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | Crypto.Crypto | HttpClient.HttpClient>,
) => harness.runPromise(Effect.scoped(effect))

const tier = (id: PlanId, patch: Partial<PricingTier>): PricingTier => ({
  id,
  name: id,
  basePriceCents: 0,
  includedCommands: 0,
  commandQuota: null,
  commandOverageCentsPerMillion: 0,
  includedStorageGb: 0,
  storageCentsPerGbMonth: 0,
  concurrentConnections: 100,
  provisional: false,
  ...patch,
})

/**
 * A small pricing table so each boundary is a few requests away: Free stops
 * at 10 weighted commands (50 units), 500,000,000 sampled bytes and 3
 * connections; Pro costs 1000 cents
 * plus 1 cent per command beyond 2, with 2 connections.
 */
const pricing: PricingConfig = {
  readCommandWeight: 0.2,
  tiers: [
    tier("free", {
      includedCommands: 10,
      commandQuota: 10,
      includedStorageGb: 0.5,
      concurrentConnections: 3,
    }),
    tier("pro", {
      basePriceCents: 1000,
      includedCommands: 2,
      commandOverageCentsPerMillion: 1_000_000,
      concurrentConnections: 2,
    }),
    tier("enterprise", {}),
  ],
}

interface Runner {
  readonly url: string
  readonly seen: Array<{
    readonly method: string
    readonly path: string
    readonly search: string
    readonly assertion: string | null
  }>
}

/** A runner that answers 200, upgrades sockets, and holds `/Watch` and `/watch` streams open. */
const runnerWith = (answer?: (request: Request) => Response | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Runner["seen"] = []

      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request, served) => {
          const { pathname: path, search } = new URL(request.url)

          if (path.endsWith("/ready")) return new Response("ok")

          seen.push({
            method: request.method,
            path,
            search,
            assertion: request.headers.get("durable-assertion"),
          })

          const answered = answer?.(request)

          if (answered !== undefined) return answered

          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            served.upgrade(request, { headers: { "sec-websocket-protocol": "akter.v1" } })

            return undefined
          }

          if (path.endsWith("/Watch") || path.endsWith("/watch"))
            return new Response(
              new ReadableStream({
                start: (controller) => controller.enqueue(new TextEncoder().encode(": open\n\n")),
              }),
              { headers: { "content-type": "text/event-stream" } },
            )

          return Response.json({})
        },
        websocket: {
          message: (ws) => void ws.send('{"t":"open","connectionId":"c"}'),
        },
      })

      return { server, runner: { url: `http://127.0.0.1:${server.port}`, seen } satisfies Runner }
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map(({ runner }) => runner))

const startRunner = runnerWith()

/** A runner that accepts a connection and drops it, so an attempt happened and its outcome is unknown. */
const startDroppingRunner = Effect.acquireRelease(
  Effect.sync(() => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: (socket) => void socket.end(), data: () => undefined },
    })

    return {
      listener,
      runner: { url: `http://127.0.0.1:${listener.port}`, seen: [] } satisfies Runner,
    }
  }),
  ({ listener }) => Effect.sync(() => listener.stop(true)),
).pipe(Effect.map(({ runner }) => runner))

const start = Effect.fnUntraced(function* (options: Partial<FixtureOptions>, runner?: Runner) {
  const edge = yield* startEdge({
    primaryRegion: "r1",
    pricing,
    plan: "free",
    ...options,
  })

  if (options.provisioned === undefined)
    yield* edge.addRunner({ region: "r1", url: (runner ?? (yield* startRunner)).url })

  return edge
})

const keyFor = (edge: FixtureEdge, tenant: string) =>
  edge.issueApiKey({ tenant, subject: `user-${tenant}` })

/** What a caller of the edge sees of an answer: its status, `retry-after`, and a refusal's reason. */
interface Reply {
  readonly status: number
  readonly retryAfter: string | undefined
  readonly reason: Readonly<Record<string, Schema.Json>>
  readonly rawBody: string
}

const decodeRefusal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.Record(Schema.String, Schema.Json) })),
)

const replyOf = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const none: Pick<Reply, "reason"> = { reason: {} }

  const body =
    response.status >= 400
      ? yield* response.text.pipe(
          Effect.flatMap(decodeRefusal),
          Effect.orElseSucceed(() => none),
        )
      : none

  return {
    status: response.status,
    retryAfter: response.headers["retry-after"],
    reason: body.reason,
    rawBody:
      response.status >= 400 ? yield* response.text.pipe(Effect.orElseSucceed(() => "")) : "",
  } satisfies Reply
})

const request = (
  edge: FixtureEdge,
  key: string | undefined,
  path: string,
  options: {
    readonly method?: HttpMethod.HttpMethod
    readonly headers?: Record<string, string>
  } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const made = HttpClientRequest.make(options.method ?? "POST")(`${edge.url}${path}`, {
      headers: options.headers,
    })

    const outgoing = key === undefined ? made : HttpClientRequest.bearerToken(made, key)

    return yield* client
      .execute(
        options.method === "OPTIONS" || options.method === "GET"
          ? outgoing
          : HttpClientRequest.bodyText(outgoing, "{}", "application/json"),
      )
      .pipe(Effect.flatMap(replyOf), Effect.orDie)
  })

const command = (
  edge: FixtureEdge,
  key: string,
  options: {
    readonly id?: string
    readonly member?: string
    readonly cid: string
    readonly actor?: string
  },
) =>
  request(
    edge,
    key,
    `/actors/${options.actor ?? "Order"}/${options.id ?? "o-1"}/${options.member ?? "Place"}`,
    { headers: { "idempotency-key": options.cid } },
  )

const read = (edge: FixtureEdge, key: string, id = "o-1") =>
  request(edge, key, `/actors/Order/${id}/Get`)

const deniedUpgrade = (edge: FixtureEdge, key?: string) =>
  request(edge, key, "/actors/Room/r1/Live", {
    method: "GET",
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-protocol": "akter.v1",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  })

/** Opens a stream and keeps it open until `stop`; the scope also ends it. */
const hold = Effect.fnUntraced(function* (edge: FixtureEdge, key: string, path: string) {
  const client = yield* HttpClient.HttpClient
  const answered = yield* Deferred.make<Reply>()
  const finished = yield* Deferred.make<string>()

  const fiber = yield* Effect.forkScoped(
    client
      .execute(
        HttpClientRequest.bodyText(
          HttpClientRequest.post(`${edge.url}${path}`, {
            headers: { authorization: `Bearer ${key}` },
          }),
          "{}",
          "application/json",
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          replyOf(response).pipe(
            Effect.flatMap((reply) => Deferred.succeed(answered, reply)),
            Effect.andThen(response.text),
            Effect.flatMap((text) => Deferred.succeed(finished, text)),
          ),
        ),
        Effect.ignore,
      ),
  )

  return {
    reply: yield* Deferred.await(answered),
    finished: Deferred.await(finished),
    stop: Fiber.interrupt(fiber),
  }
})

const watch = (edge: FixtureEdge, key: string) => hold(edge, key, "/actors/Room/r1/Watch")

interface Counters {
  readonly commandUnits: number
  readonly reservedUnits: number
}

const counters = (edge: FixtureEdge) =>
  edge.sql<Counters>`
    SELECT coalesce(sum(command_units), 0)::int AS "commandUnits",
      coalesce(sum(reserved_units), 0)::int AS "reservedUnits"
    FROM cloud_usage_account WHERE organization_id = ${edge.organizationId}
  `.pipe(
    Effect.map(([row]) => row ?? { commandUnits: 0, reservedUnits: 0 }),
    Effect.orDie,
  )

const reservationCount = (edge: FixtureEdge) =>
  edge.sql<{ readonly n: number }>`
    SELECT count(*)::int AS n FROM cloud_usage_reservation WHERE organization_id = ${edge.organizationId}
  `.pipe(
    Effect.map(([row]) => row?.n ?? 0),
    Effect.orDie,
  )

const leaseCount = (edge: FixtureEdge) =>
  edge.sql<{ readonly n: number }>`
    SELECT count(*)::int AS n FROM cloud_connection_lease
    WHERE organization_id = ${edge.organizationId} AND expires_at > now()
  `.pipe(
    Effect.map(([row]) => row?.n ?? 0),
    Effect.orDie,
  )

const settled = <A>(look: Effect.Effect<A>, done: (value: A) => boolean) =>
  look.pipe(Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: done, times: 100 }))

const Frame = Schema.fromJsonString(
  Schema.Struct({
    t: Schema.String,
    error: Schema.optionalKey(Schema.Struct({ reason: Schema.Record(Schema.String, Schema.Json) })),
  }),
)

interface Socket {
  readonly ws: WebSocket
  readonly frame: Effect.Effect<typeof Frame.Type>
  readonly ended: Effect.Effect<typeof Frame.Type>
  readonly closed: Effect.Effect<number>
}

const openSocket = Effect.fnUntraced(function* (edge: FixtureEdge, key: string) {
  const first = yield* Deferred.make<string>()
  const last = yield* Deferred.make<string>()
  const closed = yield* Deferred.make<number>()
  const ws = new WebSocket(`${edge.url.replace(/^http/, "ws")}/actors/Room/r1/Live`, ["akter.v1"])

  ws.onmessage = (event) => {
    const text = String(event.data)

    Deferred.doneUnsafe(first, Effect.succeed(text))

    if (text.includes('"t":"end"')) Deferred.doneUnsafe(last, Effect.succeed(text))
  }
  ws.onclose = (event) => Deferred.doneUnsafe(closed, Effect.succeed(event.code))
  ws.onopen = () => ws.send(`{"t":"hello","authorization":"Bearer ${key}","params":{}}`)

  yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()))

  return {
    ws,
    frame: Deferred.await(first).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Frame)),
      Effect.orDie,
    ),
    ended: Deferred.await(last).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Frame)),
      Effect.orDie,
    ),
    closed: Deferred.await(closed),
  } satisfies Socket
})

const pendingSocket = Effect.fnUntraced(function* (edge: FixtureEdge) {
  const opened = yield* Deferred.make<void>()
  const closed = yield* Deferred.make<number>()
  const ws = new WebSocket(`${edge.url.replace(/^http/, "ws")}/actors/Room/r1/Live`, ["akter.v1"])

  ws.onopen = () => Deferred.doneUnsafe(opened, Effect.void)
  ws.onclose = (event) => Deferred.doneUnsafe(closed, Effect.succeed(event.code))
  ws.onerror = () => Deferred.doneUnsafe(opened, Effect.die(new Error("Pending upgrade refused")))

  yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()))
  yield* Deferred.await(opened)

  return { closed: Deferred.await(closed) }
})

describe("meteringOf", () => {
  const classify = (method: string, path: string, key: string | null, credentialed = true) =>
    meteringOf({ method, path, idempotencyKey: key, credentialed })

  it("tells commands, reads, feeds, singletons and unattributable routes apart", () => {
    expect(classify("POST", "/actors/Order/o-1/Place", "c1")).toEqual({
      kind: "command",
      actor: "Order",
      id: "o-1",
      commandId: "c1",
    })
    expect(classify("POST", "/api/actors/Order/o%2F1/Place", '"quoted"')).toEqual({
      kind: "command",
      actor: "Order",
      id: "o/1",
      commandId: "quoted",
    })
    expect(classify("POST", "/actors/Counter/Increment", "c2")).toEqual({
      kind: "command",
      actor: "Counter",
      id: "singleton",
      commandId: "c2",
    })
    expect(classify("POST", "/actors/Counter/Get/watch", null)).toEqual({
      kind: "read",
      actor: "Counter",
      id: "singleton",
    })
    expect(classify("POST", "/actors/Counter/c-1/Get/watch", null)).toEqual({
      kind: "read",
      actor: "Counter",
      id: "c-1",
    })
    expect(classify("POST", "/actors/Order/o-1/Get", null)).toEqual({
      kind: "read",
      actor: "Order",
      id: "o-1",
    })
    expect(classify("POST", "/actors/Order/o-1/Get", "  ")).toEqual({
      kind: "read",
      actor: "Order",
      id: "o-1",
    })
    expect(classify("GET", "/actors/Order/o-1/events", null)).toEqual({ kind: "free" })
    expect(classify("GET", "/protocol", null, false)).toEqual({ kind: "free" })
    expect(classify("POST", "/command-ids", null)).toEqual({ kind: "free" })
    expect(classify("OPTIONS", "/actors/Order/o-1/Place", null)).toEqual({ kind: "free" })
    expect(classify("POST", "/mcp", null)).toEqual({ kind: "unsupported" })
    expect(classify("POST", "/mcp", null, false)).toEqual({ kind: "free" })
    expect(classify("GET", "/openapi.json", null)).toEqual({ kind: "unsupported" })
    expect(classify("GET", "/inspector/actors", null)).toEqual({ kind: "unsupported" })
    expect(classify("GET", "/actors/Order/o-1/Get", null)).toEqual({ kind: "free" })
    expect(classify("POST", "/actors/Order/o-1/Get", null, false)).toEqual({ kind: "unsupported" })
    expect(classify("POST", "/actors/Order/o-1/Place", "anon", false)).toEqual({
      kind: "command",
      actor: "Order",
      id: "o-1",
      commandId: "anon",
    })
  })
})

describe("Free hard cap", () => {
  it(
    "admits exactly 1M weighted commands, counting a read as a fifth, and refuses past it with a typed 429",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")

          for (let n = 0; n < 9; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 45 })

          for (let n = 0; n < 5; n++) expect((yield* read(edge, key)).status).toBe(200)

          const refusedRead = yield* read(edge, key)

          expect(refusedRead.status).toBe(429)
          expect(Number(refusedRead.retryAfter)).toBeGreaterThan(0)
          expect(refusedRead.reason).toMatchObject({
            limitUnits: 50,
            usedUnits: 50,
            requestedUnits: 1,
          })
          expect(refusedRead.reason["_tag"]).toBe("QuotaExceeded")

          expect((yield* command(edge, key, { cid: "late" })).status).toBe(429)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 50 })
          expect(yield* reservationCount(edge)).toBe(14)
        }),
      ),
    60_000,
  )

  it(
    "lets a retry of a held command through a full cap, whatever its member, and charges a new id",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")

          for (let n = 0; n < 10; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          const before = yield* counters(edge)

          expect(before.reservedUnits).toBe(50)

          const statuses = [
            yield* command(edge, key, { cid: "c3", id: "o-3" }),
            yield* command(edge, key, { cid: "c3", id: "o-3", member: "Cancel" }),
            yield* command(edge, key, { cid: "c3", id: "o-99" }),
            yield* command(edge, key, { cid: "c3", id: "o-3", actor: "Invoice" }),
          ].map(({ status }) => status)

          expect(statuses).toEqual([200, 200, 429, 429])
          expect(yield* counters(edge)).toEqual(before)
          expect(yield* reservationCount(edge)).toBe(10)
        }),
      ),
    60_000,
  )

  it(
    "scopes the cap to the organization across every tenant, and settles to the same total",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const a = yield* keyFor(edge, "tenant-a")
          const b = yield* keyFor(edge, "tenant-b")

          for (let n = 0; n < 8; n++)
            expect((yield* command(edge, a, { cid: `a${n}`, id: `o-${n}` })).status).toBe(200)

          for (let n = 0; n < 2; n++)
            expect((yield* command(edge, b, { cid: `a${n}`, id: `o-${n}` })).status).toBe(200)

          expect((yield* command(edge, b, { cid: "b-late" })).status).toBe(429)
          expect((yield* command(edge, a, { cid: "a-late" })).status).toBe(429)
          expect(yield* reservationCount(edge)).toBe(10)

          yield* edge.sql`
          WITH settled AS (
            UPDATE cloud_usage_reservation SET state = 'committed', settled_at = now()
            WHERE organization_id = ${edge.organizationId} AND state = 'reserved' AND kind = 'command'
            RETURNING units, period
          )
          UPDATE cloud_usage_account
          SET reserved_units = reserved_units - (SELECT sum(units) FROM settled),
            command_units = command_units + (SELECT sum(units) FROM settled)
          WHERE organization_id = ${edge.organizationId}
        `.pipe(Effect.orDie)

          expect(yield* counters(edge)).toEqual({ commandUnits: 50, reservedUnits: 0 })
          expect((yield* command(edge, a, { cid: "a-after" })).status).toBe(429)
          expect((yield* command(edge, a, { cid: "a3", id: "o-3" })).status).toBe(200)
          expect(yield* counters(edge)).toEqual({ commandUnits: 50, reservedUnits: 0 })
        }),
      ),
    60_000,
  )
})

describe("paid spend cap", () => {
  it(
    "keeps the subscribed paid base and storage in spend while applying downgraded Free entitlements",
    () =>
      run(
        Effect.gen(function* () {
          const billedPricing = {
            ...pricing,
            tiers: pricing.tiers.map((candidate) =>
              candidate.id === "pro"
                ? { ...candidate, includedStorageGb: 1, storageCentsPerGbMonth: 100 }
                : candidate,
            ),
          }
          const edge = yield* start({ plan: "pro", pricing: billedPricing })
          const key = yield* keyFor(edge, "acme")

          yield* edge.sql`UPDATE cloud_billing_account
          SET plan = 'free', spend_limit_cents = 1049, payment_status = 'past_due'
          WHERE organization_id = ${edge.organizationId}`.pipe(Effect.orDie)
          yield* edge.sql`INSERT INTO cloud_usage_account (organization_id, period, storage_gb_months)
          VALUES (${edge.organizationId}, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM'), 1.5)`.pipe(
            Effect.orDie,
          )

          const denied = yield* command(edge, key, { cid: "first" })

          expect(denied.status).toBe(402)
          expect(denied.reason).toMatchObject({ limitCents: 1049, projectedCents: 1050 })
          expect(yield* reservationCount(edge)).toBe(0)

          yield* edge.sql`UPDATE cloud_billing_account SET spend_limit_cents = NULL
          WHERE organization_id = ${edge.organizationId}`.pipe(Effect.orDie)

          for (let n = 0; n < 10; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          const quota = yield* command(edge, key, { cid: "eleventh" })

          expect(quota.status).toBe(429)
          expect(quota.reason).toMatchObject({ limitUnits: 50, usedUnits: 50, requestedUnits: 5 })

          const sockets = yield* Effect.forEach([0, 1, 2], () => openSocket(edge, key))

          for (const socket of sockets) expect((yield* socket.frame).t).toBe("open")

          const fourth = yield* deniedUpgrade(edge, key)

          expect(fourth.status).toBe(429)
          expect(fourth.reason).toMatchObject({ kind: "socket", limit: 3, open: 3 })
          expect(fourth.reason["_tag"]).toBe("ConnectionLimitExceeded")
        }),
      ),
    60_000,
  )

  const spend = (limit: number): Partial<FixtureOptions> => ({
    plan: "pro",
    spendLimitCents: limit,
  })

  it(
    "charges base plus overage against the limit and refuses the command that would pass it with a 402",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start(spend(1003))
          const key = yield* keyFor(edge, "acme")

          for (let n = 0; n < 5; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          const refusedRead = yield* read(edge, key)

          expect(refusedRead.status).toBe(402)
          expect(refusedRead.retryAfter).toBeUndefined()
          expect(refusedRead.reason).toMatchObject({ limitCents: 1003, projectedCents: 1004 })
          expect(refusedRead.reason["_tag"]).toBe("SpendLimitExceeded")

          expect((yield* command(edge, key, { cid: "c-late" })).status).toBe(402)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 25 })
          expect((yield* command(edge, key, { cid: "c4", id: "o-4" })).status).toBe(200)
        }),
      ),
    60_000,
  )

  it(
    "counts the base price, so a limit under the base refuses every metered request",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start(spend(999))
          const key = yield* keyFor(edge, "acme")
          const response = yield* command(edge, key, { cid: "c1" })

          expect(response.status).toBe(402)
          expect(response.reason).toMatchObject({ projectedCents: 1000 })
          expect(yield* reservationCount(edge)).toBe(0)
        }),
      ),
    60_000,
  )

  it(
    "has no spend cap when the limit is null and no quota on a paid plan",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "pro", spendLimitCents: null })
          const key = yield* keyFor(edge, "acme")

          for (let n = 0; n < 12; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)
        }),
      ),
    60_000,
  )
})

describe("fail closed", () => {
  it(
    "refuses metered requests before any runner sees them when nothing is bound, the account is gone, or the plan is unknown",
    () =>
      run(
        Effect.gen(function* () {
          const runner = yield* startRunner
          const edge = yield* start({ unbound: true }, runner)
          const key = yield* keyFor(edge, "acme")

          const tenantless = yield* command(edge, key, { cid: "c1" })

          expect(tenantless.status).toBe(503)
          expect(tenantless.reason).toMatchObject({ reason: "tenant" })
          expect(tenantless.reason["_tag"]).toBe("QuotaUnbound")

          yield* edge.sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id) VALUES (${edge.deployment}, '*', ${edge.organizationId}, 'proj')`.pipe(
            Effect.orDie,
          )

          const noAccount = yield* read(edge, key)

          expect(noAccount.status).toBe(503)
          expect(noAccount.reason).toMatchObject({ reason: "account" })

          yield* edge.sql`INSERT INTO cloud_billing_account (organization_id, plan) VALUES (${edge.organizationId}, 'platinum')`.pipe(
            Effect.orDie,
          )

          const unknownPlan = yield* read(edge, key)

          expect(unknownPlan.status).toBe(503)
          expect(unknownPlan.reason).toMatchObject({ reason: "plan" })

          expect(runner.seen.filter(({ path }) => path.startsWith("/actors"))).toEqual([])
          expect(yield* reservationCount(edge)).toBe(0)
        }),
      ),
    60_000,
  )

  it(
    "prefers a tenant's own binding over the wildcard and never takes the organization from a claim",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "enterprise" })
          const key = yield* keyFor(edge, "special")
          const other = `${edge.organizationId}-special`

          yield* edge.sql`INSERT INTO cloud_billing_account (organization_id, plan) VALUES (${other}, 'free')`.pipe(
            Effect.orDie,
          )
          yield* edge.sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id) VALUES (${edge.deployment}, 'special', ${other}, 'proj-special')`.pipe(
            Effect.orDie,
          )

          for (let n = 0; n < 10; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          expect((yield* command(edge, key, { cid: "late" })).status).toBe(429)

          const wildcard = yield* keyFor(edge, "ordinary")

          expect((yield* command(edge, wildcard, { cid: "c1" })).status).toBe(200)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })
        }),
      ),
    60_000,
  )

  it(
    "answers an authenticated route it cannot attribute with 501, and passes free routes with no usage rows",
    () =>
      run(
        Effect.gen(function* () {
          const runner = yield* startRunner
          const edge = yield* start({}, runner)
          const key = yield* keyFor(edge, "acme")

          const mcp = yield* request(edge, key, "/mcp")

          expect(mcp.status).toBe(501)
          expect(mcp.reason).toMatchObject({ path: "/mcp" })
          expect(mcp.reason["_tag"]).toBe("UnsupportedBillingRoute")

          const protocol = yield* request(edge, undefined, "/protocol", { method: "GET" })
          const ids = yield* request(edge, key, "/command-ids")
          const preflight = yield* request(edge, undefined, "/actors/Order/o-1/Place", {
            method: "OPTIONS",
          })

          expect([protocol.status, ids.status, preflight.status]).toEqual([200, 200, 200])
          expect(runner.seen.map(({ path }) => path)).toEqual([
            "/protocol",
            "/command-ids",
            "/actors/Order/o-1/Place",
          ])
          expect(yield* reservationCount(edge)).toBe(0)
        }),
      ),
    60_000,
  )

  it(
    "refuses uncorrelatable anonymous reads and authenticated unknown GETs, but leaves actor content GETs free",
    () =>
      run(
        Effect.gen(function* () {
          const runner = yield* startRunner
          const edge = yield* start({}, runner)
          const key = yield* keyFor(edge, "acme")
          const anonymous = yield* request(edge, undefined, "/actors/Order/o-1/Get")
          const inspector = yield* request(edge, key, "/inspector/actors", { method: "GET" })
          const openapi = yield* request(edge, undefined, "/openapi.json", { method: "GET" })
          const content = yield* request(edge, key, "/actors/Order/o-1/content", { method: "GET" })

          expect([anonymous.status, inspector.status, openapi.status, content.status]).toEqual([
            501, 501, 200, 200,
          ])
          expect(anonymous.reason["_tag"]).toBe("UnsupportedBillingRoute")
          expect(inspector.reason["_tag"]).toBe("UnsupportedBillingRoute")
          expect(runner.seen.map(({ path }) => path)).toEqual([
            "/openapi.json",
            "/actors/Order/o-1/content",
          ])
          expect(yield* reservationCount(edge)).toBe(0)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })
        }),
      ),
    60_000,
  )

  it(
    "bills an anonymous command to the framework's default tenant through the wildcard binding",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})

          const response = yield* request(edge, undefined, "/actors/Order/o-1/Place", {
            headers: { "idempotency-key": "anon-1" },
          })

          expect(response.status).toBe(200)

          const [row] = yield* edge.sql<{
            readonly tenant: string
            readonly actorType: string
            readonly actorId: string
            readonly commandId: string
          }>`
          SELECT tenant, actor_type AS "actorType", actor_id AS "actorId", command_id AS "commandId"
          FROM cloud_usage_reservation WHERE organization_id = ${edge.organizationId}
        `.pipe(Effect.orDie)

          expect(row).toEqual({
            tenant: "default",
            actorType: "Order",
            actorId: "o-1",
            commandId: "anon-1",
          })
        }),
      ),
    60_000,
  )
})

describe("read usage tokens", () => {
  const Claims = Schema.fromJsonString(Schema.Struct({ req: Schema.String }))

  it(
    "forwards each read with a fresh signed token naming its reservation, drops a client's own, and tags no command",
    () =>
      run(
        Effect.gen(function* () {
          const runner = yield* startRunner
          const edge = yield* start({}, runner)
          const key = yield* keyFor(edge, "acme")

          const response = yield* request(
            edge,
            key,
            "/actors/Order/o-1/Get?a=1&__akter_usage=forged",
          )

          expect(response.status).toBe(200)
          yield* read(edge, key)
          yield* command(edge, key, { cid: "c1" })

          const [first, second, written] = runner.seen.filter(({ path }) =>
            path.startsWith("/actors"),
          )

          const tokens = [first, second].map(
            (seen) => new URL(`http://x${seen?.path}${seen?.search}`).searchParams,
          )

          expect(tokens[0]?.getAll("__akter_usage")).toHaveLength(1)
          expect(tokens[0]?.get("a")).toBe("1")
          expect(tokens[0]?.get("__akter_usage")).not.toBe("forged")
          expect(tokens[0]?.get("__akter_usage")).not.toBe(tokens[1]?.get("__akter_usage"))
          expect(written?.search).toBe("")

          const rows = yield* edge.sql<{ readonly commandId: string }>`
          SELECT command_id AS "commandId" FROM cloud_usage_reservation
          WHERE organization_id = ${edge.organizationId} AND kind = 'read' ORDER BY command_id
        `.pipe(Effect.orDie)

          expect(rows.map(({ commandId }) => commandId)).toEqual(
            tokens.map((params) => params.get("__akter_usage") ?? "").toSorted(),
          )

          const expected = yield* requestDigest({
            method: "POST",
            target: `${first?.path}${first?.search}`,
            idempotencyKey: undefined,
            body: new TextEncoder().encode("{}"),
          }).pipe(Effect.orDie)

          const payload = yield* Effect.fromResult(
            Base64Url.decodeString(first?.assertion?.split(".")[1] ?? ""),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Claims)), Effect.orDie)

          expect(payload.req).toBe(expected)
        }),
      ),
    60_000,
  )

  it(
    "releases a stream member's read unit once it answers as a stream, and keeps a watch's initial query unit",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")

          const stream = yield* watch(edge, key)

          expect(stream.reply.status).toBe(200)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })

          const observed = yield* hold(edge, key, "/actors/Room/r1/Presence/watch")

          expect(observed.reply.status).toBe(200)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 1 })

          yield* stream.stop
          yield* observed.stop
        }),
      ),
    60_000,
  )
})

describe("definitive first-attempt rejection", () => {
  const encodeError = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

  const wire = (reason: ActorError["reason"]) =>
    actorErrorBody(ActorError.make({ reason })).pipe(Effect.flatMap(encodeError), Effect.orDie)

  it(
    "releases new reservations on decoded framework refusals and preserves the exact response",
    () =>
      run(
        Effect.gen(function* () {
          const rejections = [
            InvalidInput.make({
              code: "decode",
              issues: [{ path: "$.quantity", message: "Invalid type" }],
            }),
            Unauthorized.make({ code: "access_denied" }),
            InvalidCommandId.make({ commandId: "bad", code: "malformed" }),
            CommandExpired.make({ commandId: "old" }),
            CommandConflict.make({ commandId: "other" }),
            NotCreated.make(),
          ]
          const replies = yield* Effect.forEach(rejections, (reason) =>
            Effect.map(wire(reason), (body) => ({ status: statusOf(reason), body })),
          )
          let selected = 0
          const runner = yield* runnerWith(() => {
            const reply = replies[selected]

            return new Response(reply?.body, {
              status: reply?.status ?? 500,
              headers: { "content-type": "application/json", "x-runner-rejection": "preserved" },
            })
          })
          const edge = yield* start({}, runner)
          const key = yield* keyFor(edge, "acme")

          for (selected = 0; selected < replies.length; selected++) {
            const reply = yield* command(edge, key, { cid: `rejected-${selected}` })

            expect(reply.status).toBe(replies[selected]?.status)
            expect(reply.rawBody).toBe(replies[selected]?.body)
            expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })
          }

          selected = 1
          const deniedRead = yield* read(edge, key)

          expect(deniedRead.status).toBe(403)
          expect(deniedRead.rawBody).toBe(replies[1]?.body)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })

          const rows = yield* edge.sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM cloud_usage_reservation
          WHERE organization_id = ${edge.organizationId} AND state = 'released'
        `.pipe(Effect.orDie)

          expect(rows[0]?.n).toBe(7)
        }),
      ),
    60_000,
  )

  it(
    "keeps reservations for declared failures, malformed envelopes, timeout and unavailable",
    () =>
      run(
        Effect.gen(function* () {
          const unavailable = yield* wire(
            ActorUnavailable.make({ cause: new Error("unreachable") }),
          )
          const timeout = yield* wire(Timeout.make({ commandId: "late" }))
          const bodies = [
            { status: 422, body: '{"_tag":"InsufficientFunds","balance":17}' },
            {
              status: 400,
              body: '{"_tag":"ActorError","reason":{"_tag":"InvalidInput","code":"invented"},"isRetryable":false}',
            },
            { status: 403, body: '{"reason":{"_tag":"Unauthorized","code":"access_denied"}}' },
            { status: 503, body: unavailable },
            { status: 504, body: timeout },
          ]
          let selected = 0
          const runner = yield* runnerWith(
            () =>
              new Response(bodies[selected]?.body, {
                status: bodies[selected]?.status ?? 500,
                headers: { "content-type": "application/json" },
              }),
          )
          const edge = yield* start({}, runner)
          const key = yield* keyFor(edge, "acme")

          for (selected = 0; selected < bodies.length; selected++) {
            const reply = yield* command(edge, key, { cid: `uncertain-${selected}` })

            expect(reply.status).toBe(bodies[selected]?.status)
            expect(reply.rawBody).toBe(bodies[selected]?.body)
            expect(yield* counters(edge)).toEqual({
              commandUnits: 0,
              reservedUnits: (selected + 1) * 5,
            })
          }
        }),
      ),
    60_000,
  )

  it(
    "never releases a reused reservation or a new reservation after an earlier ambiguous attempt",
    () =>
      run(
        Effect.gen(function* () {
          const denied = yield* wire(Unauthorized.make({ code: "access_denied" }))
          let reject = false
          const runner = yield* runnerWith(() =>
            reject
              ? new Response(denied, {
                  status: 403,
                  headers: { "content-type": "application/json" },
                })
              : Response.json({}),
          )
          const edge = yield* start({}, runner)
          const key = yield* keyFor(edge, "acme")

          expect((yield* command(edge, key, { cid: "held" })).status).toBe(200)
          reject = true

          const reused = yield* command(edge, key, { cid: "held", member: "Denied" })

          expect(reused.status).toBe(403)
          expect(reused.rawBody).toBe(denied)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })

          const dropping = yield* startDroppingRunner
          const address = new URL(dropping.url)
          const padded = `http://${address.hostname}:${address.port.padStart(6, "0")}`

          yield* edge.addRunner({ region: "r1", url: padded })
          yield* Effect.sleep(250)

          const ambiguous = yield* command(edge, key, { cid: "new-after-drop" })

          expect(ambiguous.status).toBe(403)
          expect(ambiguous.rawBody).toBe(denied)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 10 })
        }),
      ),
    60_000,
  )
})

describe("ambiguous outcomes", () => {
  it(
    "keeps a command's reservation after an attempt whose outcome is unknown, and a retry reuses it",
    () =>
      run(
        Effect.gen(function* () {
          const dropping = yield* startDroppingRunner
          const edge = yield* start({}, dropping)
          const key = yield* keyFor(edge, "acme")

          expect((yield* command(edge, key, { cid: "c1" })).status).toBe(503)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })

          expect((yield* command(edge, key, { cid: "c1" })).status).toBe(503)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })
          expect(yield* reservationCount(edge)).toBe(1)
        }),
      ),
    60_000,
  )

  it(
    "keeps a read's unit after a lost reply",
    () =>
      run(
        Effect.gen(function* () {
          const dropping = yield* startDroppingRunner
          const edge = yield* start({}, dropping)
          const key = yield* keyFor(edge, "acme")

          expect((yield* read(edge, key)).status).toBe(503)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 1 })
          expect((yield* read(edge, key)).status).toBe(503)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 2 })
        }),
      ),
    60_000,
  )

  it(
    "keeps a successful read's unit reserved under its own fresh id, never adding to committed units",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")

          expect((yield* read(edge, key)).status).toBe(200)
          expect((yield* read(edge, key)).status).toBe(200)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 2 })
          expect(yield* reservationCount(edge)).toBe(2)
        }),
      ),
    60_000,
  )
})

describe("multiple edges on one database", () => {
  it(
    "counts unauthenticated upgrades against the durable budget before hello and releases them at the deadline",
    () =>
      run(
        Effect.gen(function* () {
          const bounded = {
            ...pricing,
            tiers: pricing.tiers.map((candidate) => ({ ...candidate, concurrentConnections: 2 })),
          }
          const first = yield* start({ pricing: bounded, helloTimeoutMillis: 5000 })
          const second = yield* start({
            provisioned: first.provisioned,
            pricing: bounded,
            helloTimeoutMillis: 5000,
          })
          const a = yield* pendingSocket(first)
          const b = yield* pendingSocket(second)

          expect(yield* leaseCount(first)).toBe(2)

          const denied = yield* Effect.forEach(
            Array.from({ length: 100 }, (_, n) => n),
            (n) => deniedUpgrade(n % 2 === 0 ? first : second),
            { concurrency: 8 },
          )

          for (const response of denied) {
            expect(response.status).toBe(429)
            expect(response.reason).toMatchObject({ kind: "socket", limit: 2, open: 2 })
            expect(response.reason["_tag"]).toBe("ConnectionLimitExceeded")
          }

          expect(yield* leaseCount(first)).toBe(2)
          expect(yield* a.closed).toBe(1008)
          expect(yield* b.closed).toBe(1008)
          expect(yield* settled(leaseCount(first), (n) => n === 0)).toBe(0)

          const key = yield* keyFor(first, "acme")
          const replacement = yield* openSocket(second, key)

          expect((yield* replacement.frame).t).toBe("open")
          expect(yield* leaseCount(first)).toBe(1)
        }),
      ),
    60_000,
  )

  it(
    "moves a fallback allocation to the authenticated organization before releasing its original capacity",
    () =>
      run(
        Effect.gen(function* () {
          const bounded = {
            ...pricing,
            tiers: pricing.tiers.map((candidate) => ({ ...candidate, concurrentConnections: 2 })),
          }
          const edge = yield* start({ pricing: bounded })
          const key = yield* keyFor(edge, "special")
          const actual = `${edge.organizationId}-actual`

          yield* edge.sql`INSERT INTO cloud_billing_account (organization_id, plan, subscribed_plan)
          VALUES (${actual}, 'free', 'free')`.pipe(Effect.orDie)
          yield* edge.sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
          VALUES (${edge.deployment}, 'special', ${actual}, 'actual-project')`.pipe(Effect.orDie)

          const a = yield* openSocket(edge, key)
          const b = yield* openSocket(edge, key)

          expect((yield* a.frame).t).toBe("open")
          expect((yield* b.frame).t).toBe("open")
          expect(yield* leaseCount(edge)).toBe(0)

          const rejected = yield* openSocket(edge, key)
          const ended = yield* rejected.frame

          expect(ended.t).toBe("end")
          expect(ended.error?.reason).toMatchObject({
            organizationId: actual,
            kind: "socket",
            limit: 2,
            open: 2,
          })
          expect(yield* rejected.closed).toBe(1008)
          expect(yield* settled(leaseCount(edge), (n) => n === 0)).toBe(0)

          const [counted] = yield* edge.sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM cloud_connection_lease
          WHERE organization_id = ${actual} AND expires_at > now()`.pipe(Effect.orDie)

          expect(counted?.n).toBe(2)
          const known = yield* deniedUpgrade(edge, key)

          expect(known.status).toBe(429)
          expect(known.reason).toMatchObject({
            organizationId: actual,
            kind: "socket",
            limit: 2,
            open: 2,
          })
        }),
      ),
    60_000,
  )

  it(
    "admits exactly the cap when two edges race distinct commands, and one reservation for racing retries",
    () =>
      run(
        Effect.gen(function* () {
          const first = yield* start({})
          const second = yield* start({ provisioned: first.provisioned })
          const key = yield* keyFor(first, "acme")

          const raced = yield* Effect.forEach(
            Array.from({ length: 40 }, (_, n) => n),
            (n) => command(n % 2 === 0 ? first : second, key, { cid: `c${n}`, id: `o-${n}` }),
            { concurrency: "unbounded" },
          )

          expect(raced.filter(({ status }) => status === 200)).toHaveLength(10)
          expect(raced.filter(({ status }) => status === 429)).toHaveLength(30)
          expect(yield* counters(first)).toEqual({ commandUnits: 0, reservedUnits: 50 })
          expect(yield* reservationCount(first)).toBe(10)

          const retries = yield* Effect.forEach(
            Array.from({ length: 12 }, (_, n) => n),
            (n) => command(n % 2 === 0 ? first : second, key, { cid: "c0", id: "o-0" }),
            { concurrency: "unbounded" },
          )

          expect(new Set(retries.map(({ status }) => status))).toEqual(new Set([200]))
          expect(yield* counters(first)).toEqual({ commandUnits: 0, reservedUnits: 50 })
        }),
      ),
    90_000,
  )

  it(
    "admits exactly the plan's connections across sockets and event streams on two edges",
    () =>
      run(
        Effect.gen(function* () {
          const runner = yield* startRunner
          const first = yield* start({}, runner)
          const second = yield* start({ provisioned: first.provisioned }, runner)
          const key = yield* keyFor(first, "acme")

          const a = yield* openSocket(first, key)
          const b = yield* openSocket(second, key)

          expect((yield* a.frame).t).toBe("open")
          expect((yield* b.frame).t).toBe("open")

          const stream = yield* watch(second, key)

          expect(stream.reply.status).toBe(200)
          expect(yield* leaseCount(first)).toBe(3)

          const refusedSocket = yield* deniedUpgrade(first)

          expect(refusedSocket.status).toBe(429)
          expect(refusedSocket.reason).toMatchObject({ kind: "socket", limit: 3, open: 3 })
          expect(refusedSocket.reason["_tag"]).toBe("ConnectionLimitExceeded")

          const refusedStream = yield* watch(first, key)

          expect(refusedStream.reply.status).toBe(429)
          expect(refusedStream.reply.reason).toMatchObject({ kind: "sse", limit: 3, open: 3 })
          expect(refusedStream.reply.reason["_tag"]).toBe("ConnectionLimitExceeded")

          a.ws.close()
          yield* a.closed
          expect(yield* settled(leaseCount(first), (n) => n === 2)).toBe(2)

          const replacement = yield* openSocket(second, key)

          expect((yield* replacement.frame).t).toBe("open")

          yield* stream.stop
          expect(yield* settled(leaseCount(first), (n) => n === 2)).toBe(2)

          b.ws.close()
          replacement.ws.close()
          expect(yield* settled(leaseCount(first), (n) => n === 0)).toBe(0)
        }),
      ),
    90_000,
  )

  it(
    "does not meter socket frames and charges no units for the upgrade",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")
          const socket = yield* openSocket(edge, key)

          yield* socket.frame

          for (let n = 0; n < 60; n++) socket.ws.send('{"t":"frame","frame":{"n":1}}')

          yield* Effect.sleep(300)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })
          expect(yield* reservationCount(edge)).toBe(0)
        }),
      ),
    60_000,
  )
})

describe("quotas service", () => {
  const instance = (provisioned: Provisioned, ttl: number, heartbeat: number) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()

      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

      const context = yield* Layer.build(
        Layer.mergeAll(
          PgClient.layer({ url: Redacted.make(provisioned.url), maxConnections: 6 }),
          BunCrypto.layer,
          PricingLive(pricing),
        ),
      ).pipe(Scope.provide(scope), Effect.orDie)

      const service = yield* quotas({
        leaseTtl: Duration.millis(ttl),
        leaseHeartbeat: Duration.millis(heartbeat),
      }).pipe(Effect.provideContext(context), Scope.provide(scope))

      return {
        service,
        close: Scope.close(scope, Exit.void),
        sql: Context.get(context, SqlClient.SqlClient),
      }
    })

  const bind = (edge: FixtureEdge) => ({ deployment: edge.deployment, tenant: "acme" })

  it(
    "reuses a reservation held in an earlier period, and releases then re-reserves one no attempt used",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "free" })
          const { service, sql } = yield* instance(edge.provisioned, 5000, 1000)
          const input = { ...bind(edge), actor: "Order", id: "o-1", commandId: "c1" }

          const held = yield* service.reserveCommand(input)

          expect(held).toMatchObject({ units: COMMAND_UNITS, reused: false, kind: "command" })

          yield* sql`UPDATE cloud_usage_reservation SET period = '1999-12', state = 'committed' WHERE identity = ${held.identity}`
          yield* sql`UPDATE cloud_usage_account SET reserved_units = 0 WHERE organization_id = ${edge.organizationId}`

          const replay = yield* service.reserveCommand(input)

          expect(replay).toMatchObject({ reused: true, period: "1999-12" })
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })

          const fresh = yield* service.reserveCommand({ ...input, commandId: "c2" })

          yield* service.release(fresh)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })

          yield* service.release(fresh)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })

          const again = yield* service.reserveCommand({ ...input, commandId: "c2" })

          expect(again.reused).toBe(false)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })

          yield* sql`UPDATE cloud_usage_reservation SET state = 'committed' WHERE identity = ${again.identity}`
          yield* sql`UPDATE cloud_usage_account SET reserved_units = 0, command_units = 5 WHERE organization_id = ${edge.organizationId}`
          yield* service.release(again)
          expect(yield* counters(edge)).toEqual({ commandUnits: 5, reservedUnits: 0 })
        }),
      ),
    60_000,
  )

  it(
    "keeps identities unambiguous where a delimiter would collide",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "free" })
          const { service } = yield* instance(edge.provisioned, 5000, 1000)
          const base = { ...bind(edge), actor: "A", id: "b|c", commandId: "d" }

          const first = yield* service.reserveCommand(base)
          const second = yield* service.reserveCommand({ ...base, id: "b", commandId: "c|d" })

          expect(first.identity).not.toBe(second.identity)
          expect([first.reused, second.reused]).toEqual([false, false])
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 10 })
        }),
      ),
    60_000,
  )

  it(
    "cannot release an original reservation after another edge admitted the same command",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const a = yield* instance(edge.provisioned, 5000, 1000)
          const b = yield* instance(edge.provisioned, 5000, 1000)
          const input = { ...bind(edge), actor: "Order", id: "o-1", commandId: "shared" }
          const original = yield* a.service.reserveCommand(input)
          const retry = yield* b.service.reserveCommand(input)

          expect(original.reused).toBe(false)
          expect(retry.reused).toBe(true)

          yield* a.service.release(original)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })
          expect(yield* reservationCount(edge)).toBe(1)
        }),
      ),
    60_000,
  )

  it(
    "decides an admission waiting on a committed plan or spend limit change by the new value, never the replaced one",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "pro" })
          const { service } = yield* instance(edge.provisioned, 5000, 1000)

          const blocked = edge.sql<{ readonly n: number }>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
          `.pipe(Effect.map(([row]) => (row?.n ?? 0) > 0))

          const during = Effect.fnUntraced(function* <A, E>(
            change: Effect.Effect<unknown, SqlError.SqlError>,
            admission: Effect.Effect<A, E>,
          ) {
            const changed = yield* Deferred.make<void>()
            const commit = yield* Deferred.make<void>()
            const writer = yield* edge.sql
              .withTransaction(
                change.pipe(
                  Effect.andThen(Deferred.succeed(changed, undefined)),
                  Effect.andThen(Deferred.await(commit)),
                ),
              )
              .pipe(Effect.orDie, Effect.forkScoped)

            yield* Deferred.await(changed)

            let settled = false
            const admitting = yield* admission.pipe(
              Effect.result,
              Effect.ensuring(Effect.sync(() => void (settled = true))),
              Effect.forkScoped,
            )

            yield* blocked.pipe(
              Effect.filterOrFail((waiting) => waiting || settled),
              Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
              Effect.orDie,
            )

            expect(settled).toBe(false)

            yield* Deferred.succeed(commit, undefined)
            yield* Fiber.join(writer)

            return yield* Fiber.join(admitting)
          })

          const limited = yield* during(
            edge.sql`UPDATE cloud_billing_account SET spend_limit_cents = 0
              WHERE organization_id = ${edge.organizationId}`,
            service.reserveCommand({
              ...bind(edge),
              actor: "Order",
              id: "o-1",
              commandId: "after-limit",
            }),
          )

          expect(Result.isFailure(limited) && limited.failure).toBeInstanceOf(SpendLimitExceeded)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 0 })

          yield* edge.sql`UPDATE cloud_billing_account
            SET plan = 'enterprise', subscribed_plan = 'enterprise', spend_limit_cents = NULL
            WHERE organization_id = ${edge.organizationId}`.pipe(Effect.orDie)

          const input = { ...bind(edge), kind: "socket" as const }

          for (let n = 0; n < 3; n++) yield* service.acquireLease(input)

          const downgraded = yield* during(
            edge.sql`UPDATE cloud_billing_account SET plan = 'free'
              WHERE organization_id = ${edge.organizationId}`,
            service.acquireLease(input),
          )

          expect(Result.isFailure(downgraded) && downgraded.failure).toEqual(
            ConnectionLimitExceeded.make({
              organizationId: edge.organizationId,
              kind: "socket",
              limit: 3,
              open: 3,
            }),
          )
          expect(yield* leaseCount(edge)).toBe(3)
        }),
      ),
    60_000,
  )

  it(
    "refuses a Free tenant's new commands from its latest storage sample at the included bytes, never its reads, replays or a paid plan",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "free" })
          const { service } = yield* instance(edge.provisioned, 5000, 1000)
          const command = (commandId: string) =>
            service.reserveCommand({ ...bind(edge), actor: "Order", id: "o-1", commandId })
          const sampled = (bytes: number) =>
            edge.sql`
              INSERT INTO cloud_meter_storage_sample (deployment_id, tenant, hour, logical_bytes)
              VALUES (${edge.deployment}, 'acme', date_trunc('hour', now()), ${bytes})
              ON CONFLICT (deployment_id, tenant) DO UPDATE SET logical_bytes = excluded.logical_bytes
            `.pipe(Effect.orDie)
          const refusal = (usedBytes: number) =>
            StorageQuotaExceeded.make({
              organizationId: edge.organizationId,
              deployment: edge.deployment,
              tenant: "acme",
              limitBytes: 500_000_000,
              usedBytes,
            })

          yield* sampled(499_999_999)
          expect((yield* command("held")).reused).toBe(false)

          yield* sampled(500_000_000)
          expect(yield* command("at-limit").pipe(Effect.flip)).toEqual(refusal(500_000_000))

          yield* sampled(600_000_001)
          expect(yield* command("over-limit").pipe(Effect.flip)).toEqual(refusal(600_000_001))
          expect(yield* reservationCount(edge)).toBe(1)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 5 })

          expect((yield* command("held")).reused).toBe(true)
          expect(
            (yield* service.reserveRead({ ...bind(edge), actor: "Order", id: "o-1" })).kind,
          ).toBe("read")
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 6 })

          const failure = yield* quotaFailure(refusal(600_000_001))

          expect([failure.status, failure.closeCode, failure.retryAfterMs]).toEqual([
            429,
            1008,
            undefined,
          ])
          expect(failure.body.isRetryable).toBe(false)

          yield* sampled(0)
          expect((yield* command("at-limit")).reused).toBe(false)

          yield* sampled(600_000_001)
          yield* edge.sql`UPDATE cloud_billing_account SET plan = 'pro', subscribed_plan = 'pro'
            WHERE organization_id = ${edge.organizationId}`.pipe(Effect.orDie)
          expect((yield* command("paid")).reused).toBe(false)
          expect(yield* counters(edge)).toEqual({ commandUnits: 0, reservedUnits: 16 })
        }),
      ),
    60_000,
  )

  it(
    "returns each typed failure from the service itself",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "free" })
          const { service } = yield* instance(edge.provisioned, 5000, 1000)
          const input = { ...bind(edge), actor: "Order", id: "o-1" }

          for (let n = 0; n < 10; n++)
            yield* service.reserveCommand({ ...input, commandId: `c${n}` })

          const quota = yield* service
            .reserveCommand({ ...input, commandId: "x" })
            .pipe(Effect.flip)

          expect(quota).toBeInstanceOf(QuotaExceeded)

          yield* edge.sql`UPDATE cloud_billing_account SET plan = 'pro', subscribed_plan = 'pro', spend_limit_cents = 1000 WHERE organization_id = ${edge.organizationId}`.pipe(
            Effect.orDie,
          )

          const spend = yield* service
            .reserveCommand({ ...input, commandId: "y" })
            .pipe(Effect.flip)

          expect(spend).toBeInstanceOf(SpendLimitExceeded)

          const unbound = yield* service
            .reserveCommand({ ...input, deployment: "nobody", commandId: "z" })
            .pipe(Effect.flip)

          expect(unbound).toBeInstanceOf(QuotaUnbound)
        }),
      ),
    60_000,
  )

  it(
    "counts a lost edge's leases until they expire, keeps a heartbeated one past its lifetime, and admits exactly the cap under a race",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "free" })
          const lost = yield* instance(edge.provisioned, 4000, 1000)
          const live = yield* instance(edge.provisioned, 4000, 1000)
          const other = yield* instance(edge.provisioned, 4000, 1000)
          const input = { ...bind(edge), kind: "socket" as const }

          yield* lost.service.acquireLease(input)
          yield* lost.service.acquireLease(input)

          const kept = yield* live.service.acquireLease(input)

          expect(yield* live.service.acquireLease(input).pipe(Effect.flip)).toBeInstanceOf(
            ConnectionLimitExceeded,
          )

          yield* lost.close

          yield* Effect.sleep(4400)
          expect(yield* leaseCount(edge)).toBe(1)

          const refill = yield* Effect.forEach(
            Array.from({ length: 12 }, (_, n) => (n % 2 === 0 ? live : other)),
            (racer) => Effect.result(racer.service.acquireLease(input)),
            { concurrency: "unbounded" },
          )

          expect(refill.filter(Result.isSuccess)).toHaveLength(2)
          expect(yield* leaseCount(edge)).toBe(3)

          yield* Effect.sleep(8500)
          expect(yield* leaseCount(edge)).toBe(3)

          yield* live.service.releaseLease(kept)
          expect(yield* leaseCount(edge)).toBe(2)
        }),
      ),
    60_000,
  )
})

describe("cap state agrees with admission", () => {
  const capsOf = Effect.fnUntraced(function* (edge: FixtureEdge) {
    const priced = yield* Layer.build(PricingLive(pricing))
    const caps = yield* organizationCaps(edge.organizationId).pipe(
      Effect.provideService(SqlClient.SqlClient, edge.sql),
      Effect.provideContext(priced),
      Effect.orDie,
    )

    return Object.fromEntries(caps.map((state) => [state.cap, state]))
  })

  it(
    "turns the Free command cap to refusing once a command no longer fits, before the units are all used",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")

          for (let n = 0; n < 8; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          expect((yield* capsOf(edge))["commands"]).toEqual({
            cap: "commands",
            limit: 50,
            used: 40,
            atCap: false,
            refusing: false,
          })
          expect((yield* command(edge, key, { cid: "ninth" })).status).toBe(200)
          expect((yield* read(edge, key)).status).toBe(200)
          expect((yield* capsOf(edge))["commands"]).toMatchObject({
            used: 46,
            atCap: false,
            refusing: true,
          })

          const refused = yield* command(edge, key, { cid: "tenth" })

          expect(refused.status).toBe(429)
          expect(refused.reason["_tag"]).toBe("QuotaExceeded")

          for (let n = 0; n < 4; n++) expect((yield* read(edge, key)).status).toBe(200)

          expect((yield* capsOf(edge))["commands"]).toMatchObject({
            used: 50,
            atCap: true,
            refusing: true,
          })
          expect((yield* read(edge, key)).status).toBe(429)
        }),
      ),
    60_000,
  )

  it(
    "refuses Free storage and connections exactly when their state says so",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")
          const sampled = (bytes: number) =>
            edge.sql`
              INSERT INTO cloud_meter_storage_sample (deployment_id, tenant, hour, logical_bytes)
              VALUES (${edge.deployment}, 'acme', date_trunc('hour', now()), ${bytes})
              ON CONFLICT (deployment_id, tenant) DO UPDATE SET logical_bytes = excluded.logical_bytes
            `.pipe(Effect.orDie)

          expect((yield* capsOf(edge))["storage"]).toEqual({
            cap: "storage",
            limit: 500_000_000,
            used: 0,
            atCap: false,
            refusing: false,
          })

          yield* sampled(499_999_999)
          expect((yield* capsOf(edge))["storage"]).toMatchObject({
            used: 499_999_999,
            refusing: false,
          })
          expect((yield* command(edge, key, { cid: "under" })).status).toBe(200)

          yield* sampled(500_000_000)
          expect((yield* capsOf(edge))["storage"]).toMatchObject({
            used: 500_000_000,
            atCap: true,
            refusing: true,
          })

          const refused = yield* command(edge, key, { cid: "at" })

          expect(refused.status).toBe(429)
          expect(refused.reason["_tag"]).toBe("StorageQuotaExceeded")
          expect((yield* read(edge, key)).status).toBe(200)

          const sockets = yield* Effect.forEach([0, 1], () => openSocket(edge, key))

          for (const socket of sockets) expect((yield* socket.frame).t).toBe("open")

          expect((yield* capsOf(edge))["connections"]).toEqual({
            cap: "connections",
            limit: 3,
            used: 2,
            atCap: false,
            refusing: false,
          })
          expect((yield* (yield* openSocket(edge, key)).frame).t).toBe("open")
          expect((yield* capsOf(edge))["connections"]).toMatchObject({
            used: 3,
            atCap: true,
            refusing: true,
          })
          expect((yield* deniedUpgrade(edge, key)).status).toBe(429)
        }),
      ),
    60_000,
  )

  it(
    "prices the spend cap on the next command, and leaves a paid plan without command or storage caps",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "pro", spendLimitCents: 1003 })
          const key = yield* keyFor(edge, "acme")

          for (let n = 0; n < 4; n++)
            expect((yield* command(edge, key, { cid: `c${n}`, id: `o-${n}` })).status).toBe(200)

          const before = yield* capsOf(edge)

          expect(before["spend"]).toEqual({
            cap: "spend",
            limit: 1003,
            used: 1002,
            atCap: false,
            refusing: false,
          })
          expect(before["commands"]).toEqual({
            cap: "commands",
            limit: null,
            used: 20,
            atCap: false,
            refusing: false,
          })
          expect(before["storage"]).toMatchObject({ limit: null, refusing: false })
          expect((yield* command(edge, key, { cid: "fifth" })).status).toBe(200)
          expect((yield* capsOf(edge))["spend"]).toMatchObject({
            used: 1003,
            atCap: true,
            refusing: true,
          })

          const refused = yield* command(edge, key, { cid: "sixth" })

          expect(refused.status).toBe(402)
          expect(refused.reason["_tag"]).toBe("SpendLimitExceeded")
        }),
      ),
    60_000,
  )
})

describe("typed client quota refusals", () => {
  const Probe = Actor.make("BillingProbe", {
    key: Schema.String,
    api: {
      Get: Actor.query("Get", { success: Schema.Json }),
      Watch: Actor.stream("Watch", { success: Schema.Json }),
    },
  })

  it(
    "preserves all three hosted reasons through the real Promise and streaming clients",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({})
          const key = yield* keyFor(edge, "acme")
          const handle = Probe.client({
            baseUrl: edge.url,
            headers: { authorization: `Bearer ${key}` },
          }).get("p-1")

          yield* edge.sql`
          INSERT INTO cloud_usage_account (organization_id, period, command_units)
          VALUES (${edge.organizationId}, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM'), 50)
        `.pipe(Effect.orDie)

          const quota = yield* Effect.promise(() => handle.Get().then(Result.succeed, Result.fail))

          expect(Result.isFailure(quota)).toBe(true)

          if (Result.isFailure(quota)) {
            expect(quota.failure).toBeInstanceOf(ClientActorError)

            if (Schema.is(ClientActorError)(quota.failure)) {
              expect(quota.failure.reason).toBeInstanceOf(ClientQuotaExceeded)
              expect(quota.failure.reason).toMatchObject({
                limitUnits: 50,
                usedUnits: 50,
                requestedUnits: 1,
              })
              expect(quota.failure.isRetryable).toBe(false)
              expect(Option.getOrUndefined(quota.failure.retryAfter)).toBeGreaterThan(0)
            }
          }

          yield* edge.sql`UPDATE cloud_billing_account SET plan = 'pro', subscribed_plan = 'pro', spend_limit_cents = 999 WHERE organization_id = ${edge.organizationId}`.pipe(
            Effect.orDie,
          )
          yield* edge.sql`UPDATE cloud_usage_account SET command_units = 0 WHERE organization_id = ${edge.organizationId}`.pipe(
            Effect.orDie,
          )

          const spend = yield* Effect.promise(() => handle.Get().then(Result.succeed, Result.fail))

          expect(Result.isFailure(spend)).toBe(true)

          if (Result.isFailure(spend)) {
            expect(spend.failure).toBeInstanceOf(ClientActorError)

            if (Schema.is(ClientActorError)(spend.failure)) {
              expect(spend.failure.reason).toBeInstanceOf(ClientSpendLimitExceeded)
              expect(spend.failure.reason).toMatchObject({ limitCents: 999, projectedCents: 1000 })
              expect(spend.failure.isRetryable).toBe(false)
            }
          }

          yield* edge.sql`UPDATE cloud_billing_account SET plan = 'free', subscribed_plan = 'free', spend_limit_cents = NULL WHERE organization_id = ${edge.organizationId}`.pipe(
            Effect.orDie,
          )

          const sockets = yield* Effect.forEach([0, 1, 2], () => openSocket(edge, key))

          for (const socket of sockets) expect((yield* socket.frame).t).toBe("open")

          const connected = yield* Effect.promise(() =>
            handle.Watch()[Symbol.asyncIterator]().next().then(Result.succeed, Result.fail),
          )

          expect(Result.isFailure(connected)).toBe(true)

          if (Result.isFailure(connected)) {
            expect(connected.failure).toBeInstanceOf(ClientActorError)

            if (Schema.is(ClientActorError)(connected.failure)) {
              expect(connected.failure.reason).toBeInstanceOf(ClientConnectionLimitExceeded)
              expect(connected.failure.reason).toMatchObject({ kind: "sse", limit: 3, open: 3 })
              expect(connected.failure.isRetryable).toBe(true)
            }
          }
        }),
      ),
    60_000,
  )
})

describe("lost leases", () => {
  const instance = (provisioned: Provisioned) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()

      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

      const context = yield* Layer.build(
        Layer.mergeAll(
          PgClient.layer({ url: Redacted.make(provisioned.url), maxConnections: 6 }),
          BunCrypto.layer,
          PricingLive(pricing),
        ),
      ).pipe(Scope.provide(scope), Effect.orDie)

      return yield* quotas({
        leaseTtl: Duration.millis(3000),
        leaseHeartbeat: Duration.millis(1000),
      }).pipe(Effect.provideContext(context), Scope.provide(scope))
    })

  const stallRenewals = (edge: FixtureEdge, millis: number) =>
    Effect.forkScoped(
      edge.sql
        .withTransaction(
          Effect.andThen(
            edge.sql`LOCK TABLE cloud_connection_lease IN SHARE ROW EXCLUSIVE MODE`,
            Effect.sleep(millis),
          ),
        )
        .pipe(Effect.orDie),
    )

  const live = (edge: FixtureEdge) =>
    edge.sql<{ readonly live: boolean }>`
      SELECT bool_and(expires_at > now()) AS live FROM cloud_connection_lease
      WHERE organization_id = ${edge.organizationId}
    `.pipe(
      Effect.map(([row]) => row?.live ?? false),
      Effect.orDie,
    )

  it(
    "tells a holder its lease is lost while the database still counts it, and never revives the expired row",
    () =>
      run(
        Effect.gen(function* () {
          const edge = yield* start({ plan: "free" })
          const service = yield* instance(edge.provisioned)
          const input = { deployment: edge.deployment, tenant: "acme", kind: "socket" as const }

          const lease = yield* service.acquireLease(input)

          expect(yield* lease.isLost).toBe(false)

          const stalled = yield* stallRenewals(edge, 6000)

          yield* lease.lost
          expect(yield* live(edge)).toBe(true)
          expect(yield* lease.isLost).toBe(true)

          yield* Fiber.join(stalled)
          yield* Effect.sleep(700)

          expect(yield* live(edge)).toBe(false)

          const other = yield* instance(edge.provisioned)

          for (let n = 0; n < 3; n++) yield* other.acquireLease(input)

          expect(yield* other.acquireLease(input).pipe(Effect.flip)).toBeInstanceOf(
            ConnectionLimitExceeded,
          )
          expect(yield* leaseCount(edge)).toBe(3)
        }),
      ),
    60_000,
  )

  it(
    "closes a live socket and ends a live event stream before another edge could take their capacity",
    () =>
      run(
        Effect.gen(function* () {
          const runner = yield* startRunner
          const first = yield* start({ leaseTtlMillis: 3000, leaseHeartbeatMillis: 1000 }, runner)
          const second = yield* start(
            { provisioned: first.provisioned, leaseTtlMillis: 3000, leaseHeartbeatMillis: 1000 },
            runner,
          )
          const key = yield* keyFor(first, "acme")

          const socket = yield* openSocket(first, key)
          const stream = yield* watch(first, key)

          expect((yield* socket.frame).t).toBe("open")
          expect(stream.reply.status).toBe(200)
          expect(yield* leaseCount(first)).toBe(2)

          const stalled = yield* stallRenewals(first, 6000)

          const ended = yield* socket.ended

          expect(ended.error?.reason["_tag"]).toBe("QuotaUnavailable")
          expect(yield* socket.closed).toBe(1013)

          const text = yield* stream.finished

          expect(text).toContain("event: end")
          expect(text).toContain("QuotaUnavailable")
          expect(yield* live(first)).toBe(true)

          yield* Fiber.join(stalled)
          expect(yield* settled(leaseCount(first), (n) => n === 0)).toBe(0)

          const takers = yield* Effect.forEach([0, 1, 2], () => openSocket(second, key), {
            concurrency: "unbounded",
          })

          for (const taker of takers) expect((yield* taker.frame).t).toBe("open")

          expect(yield* leaseCount(first)).toBe(3)
        }),
      ),
    90_000,
  )
})
