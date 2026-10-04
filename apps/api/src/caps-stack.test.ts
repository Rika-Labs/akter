import * as Cloud from "@akter/cloud-api"
import { edgeKey } from "@rikalabs/akter/testing"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  Crypto,
  Deferred,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect"
import {
  Cookies,
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PlatformError } from "effect/PlatformError"
import { Pool } from "pg"
import { serviceCredential } from "./rollout.ts"

/**
 * The documented Docker Compose stack, `infra/local/compose.yaml` under its
 * own project name and free ports, driven over HTTP into each usage cap: the
 * console's command endpoint for the command, storage and spend caps, the
 * edge itself for the connection cap and for metered reads. Usage and billing
 * must report every cap's `atCap` and `refusing` exactly as the edge decides.
 *
 * One override keeps the edge from closing the connection-cap scenario's
 * sockets for want of a `hello` while they hold their leases.
 *
 * SQL sets only what no public surface does: the operator's tenant
 * allocation, a Free period's committed units near its million-command cap,
 * and a storage sample that a collector would otherwise take hourly. The
 * Compose project with its volumes and built images, the runner and migration
 * containers started from the runner image tagged here, and that image are
 * the only Docker objects it creates and removes.
 */
const repository = new URL("../../../", import.meta.url).pathname
const composeFile = "infra/local/compose.yaml"
const localSecret = "local-development-only-change-before-production"
const password = "correct-horse-battery-staple-42"
const FREE_UNITS = 5_000_000
const FREE_STORAGE = 500_000_000
const FREE_CONNECTIONS = 100
const PRO_BASE_CENTS = 2_500

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const text = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText, Stream.mkString)

const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...args], { cwd: repository, extendEnv: true, env }),
    )

    const [out, err] = yield* Effect.all([text(handle.stdout), text(handle.stderr)], {
      concurrency: 2,
    })

    return { code: Number(yield* handle.exitCode), out: out.trim(), err: err.trim() }
  }).pipe(Effect.scoped, Effect.orDie)

const freePort = Effect.sync(() => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = probe.port ?? 0

  void probe.stop(true)

  return port
})

/** Retries `effect` every 500 ms until `done` accepts its value or `seconds` pass. */
const poll = <A, E, R>(
  what: string,
  seconds: number,
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
) =>
  effect.pipe(
    Effect.filterOrFail(done),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: Math.ceil(seconds / 0.5) }),
    Effect.mapError(() => new Error(`timed out waiting for ${what}`)),
    Effect.orDie,
  )

/** A response's status and its body as text, read once. */
const replyOf = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.map((body) => ({ status: response.status, body, cookies: response.cookies })),
    Effect.orDie,
  )

type Reply = Effect.Success<ReturnType<typeof replyOf>>

const decode = <S extends Schema.Top>(schema: S, reply: Reply) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(reply.body).pipe(
    Effect.orDie,
  )

/** The envelope the edge refuses a request in. */
const Refusal = Schema.Struct({
  reason: Schema.Union([Cloud.ConnectionLimitExceeded, Cloud.QuotaExceeded]),
})

/** A Compose project of the documented local stack, brought down with the scope. */
const composeStack = Effect.gen(function* () {
  const id = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
  const project = `akter-caps-${id}`
  const ports = {
    pg: yield* freePort,
    api: yield* freePort,
    edge: yield* freePort,
    outbox: yield* freePort,
  }
  const signing = yield* edgeKey(`local-caps-${id}`)
  const jwk = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", signing.privateKey))
  const env = {
    COMPOSE_PROJECT_NAME: project,
    CONTROL_PLANE_PG_PORT: String(ports.pg),
    API_HTTP_PORT: String(ports.api),
    EDGE_HTTP_PORT: String(ports.edge),
    OUTBOX_HTTP_PORT: String(ports.outbox),
    API_ORIGIN: `http://localhost:${ports.api}`,
    EDGE_SIGNING_KEYS: yield* encodeJson([
      { kid: `local-caps-${id}`, x: jwk.x ?? "", d: jwk.d ?? "" },
    ]).pipe(Effect.orDie),
    EDGE_PUBLICATION_LEAD: "0 seconds",
  }
  const override = `${Bun.env["TMPDIR"] ?? "/tmp/"}${project}.yaml`

  yield* Effect.acquireRelease(
    Effect.promise(() =>
      Bun.write(
        override,
        'services:\n  edge:\n    environment:\n      EDGE_HELLO_TIMEOUT: "10 minutes"\n',
      ),
    ),
    () => Effect.promise(() => Bun.file(override).delete()),
  )

  const compose = (...args: ReadonlyArray<string>) =>
    run("docker", ["compose", "-p", project, "-f", composeFile, "-f", override, ...args], env)
  const runnerTag = `akter-local-runner:caps-${id}`

  const built = yield* Effect.acquireRelease(
    run("docker", ["build", "-f", "infra/local/runner/Dockerfile", "-t", runnerTag, "."]),
    () =>
      Effect.gen(function* () {
        const left = yield* run("docker", ["ps", "-aq", "--filter", `ancestor=${runnerTag}`])

        for (const container of left.out.split("\n").filter(Boolean))
          yield* run("docker", ["rm", "-f", container])

        yield* run("docker", ["image", "rm", runnerTag])
      }),
  )

  expect(built.code, built.err.slice(-2000)).toBe(0)

  const up = yield* Effect.acquireRelease(compose("up", "--build", "--detach", "--wait"), () =>
    Effect.gen(function* () {
      const runners = yield* run("docker", [
        "ps",
        "-aq",
        "--filter",
        `network=${project}_default`,
        "--filter",
        "label=akter.deployment",
      ])

      for (const container of runners.out.split("\n").filter(Boolean))
        yield* run("docker", ["rm", "-f", container])

      yield* compose("down", "--volumes", "--rmi", "local", "--remove-orphans")
    }),
  )

  if (up.code !== 0) {
    const logs = yield* compose("logs", "--tail", "80")

    expect(up.code, `${up.err.slice(-2000)}\n${logs.out.slice(-6000)}`).toBe(0)
  }

  const pool = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Pool({
          connectionString: `postgres://project:project@127.0.0.1:${ports.pg}/project`,
          max: 2,
        }),
    ),
    (opened) => Effect.promise(() => opened.end()),
  )

  return {
    compose,
    ports,
    pool,
    origin: env.API_ORIGIN,
    image: (yield* run("docker", ["image", "inspect", "-f", "{{.Id}}", runnerTag])).out,
  }
})

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)

layer(services, { excludeTestServices: true, timeout: Duration.minutes(30) })(
  "usage caps on the documented Compose stack",
  (it) => {
    it.effect(
      "refuses each cap over HTTP with its typed error while usage and billing report it identically",
      () =>
        Effect.gen(function* () {
          const stack = yield* composeStack
          const client = yield* HttpClient.HttpClient
          const api = `http://127.0.0.1:${stack.ports.api}`

          const sql = <Row extends Record<string, unknown>>(
            statement: string,
            values: ReadonlyArray<string | number> = [],
          ) =>
            Effect.promise(() => stack.pool.query<Row>(statement, [...values])).pipe(
              Effect.map((result) => result.rows),
            )

          const send = (request: HttpClientRequest.HttpClientRequest) =>
            client
              .execute(request)
              .pipe(
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
                Effect.orDie,
                Effect.flatMap(replyOf),
              )

          const call = (
            path: string,
            init: {
              readonly method?: "GET" | "POST" | "PUT"
              readonly body?: Schema.Json
              readonly cookie?: string
              readonly headers?: Record<string, string>
            } = {},
          ) =>
            Effect.gen(function* () {
              const base = HttpClientRequest.make(init.method ?? "GET")(`${api}${path}`).pipe(
                HttpClientRequest.setHeaders({ origin: stack.origin, ...init.headers }),
              )
              const withCookie =
                init.cookie === undefined
                  ? base
                  : HttpClientRequest.setHeader(base, "cookie", init.cookie)

              return yield* send(
                init.body === undefined
                  ? withCookie
                  : yield* HttpClientRequest.bodyJson(init.body)(withCookie).pipe(Effect.orDie),
              )
            })

          const ok = <S extends Schema.Top>(
            schema: S,
            path: string,
            init: Parameters<typeof call>[1] = {},
          ) =>
            call(path, init).pipe(
              Effect.tap((reply) => Effect.sync(() => expect(reply.status, reply.body).toBe(200))),
              Effect.flatMap((reply) => decode(schema, reply)),
            )

          const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
          const email = `alice-${suffix}@example.com`

          expect(
            (yield* call("/auth/sign-up/email", {
              method: "POST",
              body: { name: "alice", email, password },
            })).status,
          ).toBe(200)

          const [verification] = yield* poll(
            "the verification email",
            30,
            sql<{ body: string }>(
              "SELECT body FROM cloud_email_outbox WHERE recipient = $1 AND subject = 'Verify your email' ORDER BY id DESC LIMIT 1",
              [email],
            ),
            (rows) => rows.length === 1,
          )
          const link = new URL(verification?.body ?? "")

          expect((yield* call(link.pathname + link.search)).status).toBe(302)

          const login = yield* call("/auth/sign-in/email", {
            method: "POST",
            body: { email, password },
          })

          expect(login.status).toBe(200)

          const cookie = Cookies.toCookieHeader(login.cookies)

          expect((yield* call("/api/billing/plans")).status).toBe(401)
          expect(
            (yield* ok(Cloud.PlanCatalog, "/api/billing/plans", { cookie })).plans.map(
              (plan) => plan.id,
            ),
          ).toEqual(["free", "pro", "team", "enterprise"])

          const membership = yield* ok(Cloud.OrganizationMembership, "/api/organizations", {
            method: "POST",
            cookie,
            body: { name: "Caps", slug: `caps-${suffix}` },
          })
          const org = membership.organization.id
          const project = yield* ok(Cloud.Project, `/api/organizations/${org}/projects`, {
            method: "POST",
            cookie,
            body: { name: "Counter app", slug: "counter-app", homeRegion: "us-east-1" },
          })
          const deployments = `/api/projects/${project.id}/deployments`
          const commitSha = "c".repeat(40)
          const { id: deployment } = yield* ok(Cloud.DeploymentDetail, deployments, {
            method: "POST",
            cookie,
            body: { environment: "production", commitSha },
          })

          yield* ok(Cloud.DeploymentDetail, `${deployments}/${deployment}/build`, {
            method: "POST",
            cookie,
            body: { image: stack.image, commitSha, environmentSnapshot: {} },
          })

          const settled = yield* poll(
            "the deployment to settle",
            300,
            ok(Cloud.DeploymentDetail, `${deployments}/${deployment}`, { cookie }),
            (detail) => detail.status !== "in-progress",
          )

          if (settled.status !== "live") {
            const logs = yield* stack.compose("logs", "--tail", "120", "api")
            const runners = yield* run("docker", [
              "ps",
              "-aq",
              "--filter",
              `label=akter.deployment=${deployment}`,
            ])

            for (const container of runners.out.split("\n").filter(Boolean)) {
              const runnerLogs = yield* run("docker", ["logs", "--tail", "60", container])
              const state = yield* run("docker", ["inspect", "-f", "{{json .State}}", container])

              yield* Effect.logError(
                `runner ${container} ${state.out}\n${runnerLogs.out}\n${runnerLogs.err}`,
              )
            }
            const steps = yield* encodeJson(
              settled.steps.map((step) => ({
                name: step.name,
                status: step.status,
                detail: step.detail,
              })),
            ).pipe(Effect.orDie)

            expect(settled.status, `${steps}\n${logs.out.slice(-8000)}`).toBe("live")
          }

          const edge = `http://${deployment}.localhost:${stack.ports.edge}`
          const credential = serviceCredential(Redacted.make(localSecret), deployment)

          const sendCommand = Effect.gen(function* () {
            const commandId = yield* (yield* Crypto.Crypto).randomUUIDv4

            return yield* call(
              `/api/projects/${project.id}/environments/production/runtime/commands`,
              {
                method: "POST",
                cookie,
                body: { address: "Counter/hits", command: "Increment", payload: 1, commandId },
              },
            )
          })

          const unbound = yield* sendCommand

          expect(unbound.status, unbound.body).toBe(503)

          yield* sql(
            "INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id) VALUES ($1, 'default', $2, $3)",
            [deployment, org, project.id],
          )

          const admitted = yield* poll(
            "the first admitted command",
            60,
            sendCommand,
            (reply) => reply.status !== 503,
          )

          expect(admitted.status, admitted.body).toBe(200)

          const read = send(
            HttpClientRequest.post(`${edge}/actors/Counter/hits/Value`).pipe(
              HttpClientRequest.bearerToken(Redacted.value(credential)),
            ),
          )

          const closed: Array<string> = []
          const sockets: Array<WebSocket> = []

          /** Both reports' caps, which must agree, keyed by cap. */
          const caps = Effect.gen(function* () {
            const usage = yield* ok(Cloud.Usage, `/api/organizations/${org}/usage`, { cookie })
            const billing = yield* ok(Cloud.BillingSummary, `/api/organizations/${org}/billing`, {
              cookie,
            })
            const states = usage.caps ?? []

            expect(states.map((state) => state.cap)).toEqual([
              "commands",
              "spend",
              "connections",
              "storage",
            ])
            const rows = yield* sql<{ total: number; live: number }>(
              `SELECT count(*)::int AS total, count(*) FILTER (WHERE expires_at > now())::int AS live
               FROM cloud_connection_lease WHERE organization_id = $1`,
              [org],
            )
            const edgeLogs = yield* stack.compose("logs", "--tail", "30", "edge")
            const [leases] = rows
            expect(
              billing.caps,
              `lease rows ${leases?.total} (${leases?.live} live), client sockets open ${sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length}, closed [${closed.join(", ")}]\n${edgeLogs.out.slice(-3000)}`,
            ).toEqual(states)

            const of = (cap: Cloud.CapState["cap"]) => states.find((state) => state.cap === cap)

            return {
              commands: of("commands"),
              spend: of("spend"),
              connections: of("connections"),
              storage: of("storage"),
              sample: usage.latestStorageSample,
            }
          })

          const setUsedUnits = (units: number) =>
            sql(
              `UPDATE cloud_usage_account SET command_units = $1 - reserved_units
               WHERE organization_id = $2 AND period = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM')`,
              [units, org],
            )

          yield* setUsedUnits(FREE_UNITS - 7)
          expect((yield* caps).commands).toEqual({
            cap: "commands",
            limit: FREE_UNITS,
            used: FREE_UNITS - 7,
            atCap: false,
            refusing: false,
          })
          expect((yield* sendCommand).status).toBe(200)
          expect((yield* caps).commands).toEqual({
            cap: "commands",
            limit: FREE_UNITS,
            used: FREE_UNITS - 2,
            atCap: false,
            refusing: true,
          })

          const quota = yield* sendCommand

          expect(quota.status, quota.body).toBe(429)

          const exceeded = yield* decode(Cloud.QuotaExceeded, quota)

          expect(exceeded).toBeInstanceOf(Cloud.QuotaExceeded)
          expect(exceeded).toMatchObject({
            organizationId: org,
            limitUnits: FREE_UNITS,
            usedUnits: FREE_UNITS - 2,
            requestedUnits: 5,
          })

          const firstRead = yield* read

          expect(firstRead.status, firstRead.body).toBe(200)
          expect((yield* read).status).toBe(200)
          expect((yield* caps).commands).toMatchObject({
            used: FREE_UNITS,
            atCap: true,
            refusing: true,
          })

          const lastRead = yield* read

          expect(lastRead.status).toBe(429)
          expect((yield* decode(Refusal, lastRead)).reason).toBeInstanceOf(Cloud.QuotaExceeded)

          yield* setUsedUnits(100)
          const reset = yield* caps

          expect(reset.commands).toMatchObject({ used: 100, refusing: false })
          expect(reset.sample).toBeNull()

          const sample = (bytes: number) =>
            sql(
              `INSERT INTO cloud_meter_storage_sample (deployment_id, tenant, hour, logical_bytes)
               VALUES ($1, 'default', date_trunc('hour', now()), $2)
               ON CONFLICT (deployment_id, tenant)
               DO UPDATE SET logical_bytes = excluded.logical_bytes, hour = excluded.hour`,
              [deployment, bytes],
            )

          yield* sample(FREE_STORAGE - 1)
          expect((yield* caps).storage).toEqual({
            cap: "storage",
            limit: FREE_STORAGE,
            used: FREE_STORAGE - 1,
            atCap: false,
            refusing: false,
          })
          expect((yield* sendCommand).status).toBe(200)

          yield* sample(FREE_STORAGE)
          const stored = yield* caps

          expect(stored.storage).toEqual({
            cap: "storage",
            limit: FREE_STORAGE,
            used: FREE_STORAGE,
            atCap: true,
            refusing: true,
          })
          expect(stored.sample?.bytes).toBe(FREE_STORAGE)

          const full = yield* sendCommand

          expect(full.status, full.body).toBe(429)
          expect(yield* decode(Cloud.StorageQuotaExceeded, full)).toEqual(
            Cloud.StorageQuotaExceeded.make({
              organizationId: org,
              deployment,
              tenant: "default",
              limitBytes: FREE_STORAGE,
              usedBytes: FREE_STORAGE,
            }),
          )
          expect((yield* read).status).toBe(200)

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const ws of sockets) ws.close()
            }),
          )

          const open = (count: number) =>
            Effect.forEach(
              Array.from({ length: count }, (_, index) => index),
              () =>
                Effect.gen(function* () {
                  const opened = yield* Deferred.make<boolean>()
                  const ws = new WebSocket(
                    `${edge.replace(/^http/u, "ws")}/actors/Counter/hits/Live`,
                    "akter.v1",
                  )

                  sockets.push(ws)
                  ws.onopen = () => Deferred.doneUnsafe(opened, Effect.succeed(true))
                  ws.onerror = () => Deferred.doneUnsafe(opened, Effect.succeed(false))
                  ws.onclose = (event) => {
                    if (sockets.includes(ws)) closed.push(`${event.code} ${event.reason}`)
                  }

                  expect(yield* Deferred.await(opened)).toBe(true)
                }),
              { concurrency: 20, discard: true },
            )

          yield* open(FREE_CONNECTIONS - 1)
          expect(closed).toEqual([])
          expect((yield* caps).connections).toEqual({
            cap: "connections",
            limit: FREE_CONNECTIONS,
            used: FREE_CONNECTIONS - 1,
            atCap: false,
            refusing: false,
          })
          yield* open(1)
          expect((yield* caps).connections).toEqual({
            cap: "connections",
            limit: FREE_CONNECTIONS,
            used: FREE_CONNECTIONS,
            atCap: true,
            refusing: true,
          })

          const denied = yield* send(
            HttpClientRequest.get(`${edge}/actors/Counter/hits/Live`).pipe(
              HttpClientRequest.setHeaders(
                Headers.fromInput({
                  connection: "Upgrade",
                  upgrade: "websocket",
                  "sec-websocket-protocol": "akter.v1",
                  "sec-websocket-version": "13",
                  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                }),
              ),
            ),
          )

          expect(denied.status, denied.body).toBe(429)
          expect((yield* decode(Refusal, denied)).reason).toEqual(
            Cloud.ConnectionLimitExceeded.make({
              organizationId: org,
              kind: "socket",
              limit: FREE_CONNECTIONS,
              open: FREE_CONNECTIONS,
            }),
          )

          yield* Effect.sync(() => {
            for (const ws of sockets.splice(0)) ws.close()
          })
          yield* poll(
            "the closed sockets' leases to be released",
            30,
            caps.pipe(Effect.map((found) => found.connections?.used)),
            (used) => used === 0,
          )

          const session = yield* ok(
            Cloud.HostedSession,
            `/api/organizations/${org}/billing/checkout`,
            {
              method: "POST",
              cookie,
              body: { plan: "pro" },
              headers: { "idempotency-key": `caps-${suffix}` },
            },
          )

          expect((yield* call(new URL(session.url).pathname, { method: "POST" })).status).toBe(200)
          yield* poll(
            "the Pro entitlement",
            60,
            ok(Cloud.BillingSummary, `/api/organizations/${org}/billing`, { cookie }),
            (summary) => summary.plan.id === "pro",
          )

          const [invoice] = yield* ok(
            Schema.Array(Cloud.Invoice),
            `/api/organizations/${org}/billing/invoices`,
            { cookie },
          )
          const pdf = yield* call(new URL(invoice?.pdfUrl ?? "http://invalid/").pathname)

          expect(pdf.status).toBe(200)
          expect(pdf.body.startsWith("%PDF-1.4")).toBe(true)

          const limit = (cents: number) =>
            ok(Cloud.SpendLimit, `/api/organizations/${org}/billing/spend-limit`, {
              method: "PUT",
              cookie,
              body: { limitCents: cents },
            })

          yield* limit(PRO_BASE_CENTS)
          const pro = yield* caps

          expect(pro.spend).toEqual({
            cap: "spend",
            limit: PRO_BASE_CENTS,
            used: PRO_BASE_CENTS,
            atCap: true,
            refusing: false,
          })
          expect(pro.commands).toMatchObject({ limit: null, atCap: false, refusing: false })
          expect(pro.storage).toMatchObject({ limit: null, atCap: false, refusing: false })
          expect((yield* sendCommand).status).toBe(200)

          yield* limit(PRO_BASE_CENTS - 1)
          expect((yield* caps).spend).toEqual({
            cap: "spend",
            limit: PRO_BASE_CENTS - 1,
            used: PRO_BASE_CENTS,
            atCap: true,
            refusing: true,
          })

          const spend = yield* sendCommand

          expect(spend.status, spend.body).toBe(402)

          const passed = yield* decode(Cloud.SpendLimitExceeded, spend)

          expect(passed).toBeInstanceOf(Cloud.SpendLimitExceeded)
          expect(passed).toMatchObject({
            organizationId: org,
            limitCents: PRO_BASE_CENTS - 1,
            projectedCents: PRO_BASE_CENTS,
          })
        }).pipe(Effect.scoped),
      1_800_000,
    )
  },
)
