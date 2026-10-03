import * as Cloud from "@akter/cloud-api"
import { edgeKey } from "@rikalabs/akter/testing"
import { BunCrypto, BunHttpServer, BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  Clock,
  Config,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect"
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpRouter,
} from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PlatformError } from "effect/PlatformError"
import { Pool } from "pg"
import type { ApiOptions } from "./config.ts"
import { infrastructure, routes } from "./server.ts"

/**
 * Real containers, real Postgres, the real edge process and the real API
 * layers: the runner image is built from this repository, deployed through
 * the API's lifecycle endpoints, and commands reach it only through the edge.
 * Each scenario owns an isolated database and removes only the containers it
 * created or that carry a deployment id it minted, because the Docker daemon
 * and the Postgres server are shared.
 */
const repository = new URL("../../../", import.meta.url).pathname
const issuer = "https://edge.local.test"
const region = "us-east-1"
const apiOrigin = "http://localhost:3001"
const migrateCommand = ["bun", "infra/local/runner/migrate.ts"]
const password = "correct-horse-battery-staple-42"

class Images extends Context.Service<Images, { readonly v1: string; readonly v2: string }>()(
  "@akter/api/deployment-stack.test/Images",
) {}

const text = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(Stream.decodeText, Stream.mkString)

const docker = (...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("docker", [...args]))

    const [out, err] = yield* Effect.all([text(handle.stdout), text(handle.stderr)], {
      concurrency: 2,
    })

    return { code: Number(yield* handle.exitCode), out: out.trim(), err: err.trim() }
  }).pipe(Effect.scoped, Effect.orDie)

const unique = (prefix: string) =>
  Effect.gen(function* () {
    return `${prefix}-${(yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)}`
  })

/** Retries `effect` every 300 ms until `done` accepts its value or `seconds` pass. */
const poll = <A, E, R>(
  what: string,
  seconds: number,
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
) =>
  effect.pipe(
    Effect.filterOrFail(done),
    Effect.retry({ schedule: Schedule.spaced("300 millis"), times: Math.ceil(seconds / 0.3) }),
    Effect.mapError(() => new Error(`timed out waiting for ${what}`)),
    Effect.orDie,
  )

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

/** A new database on the shared test server, dropped with the scope; the second URL is how containers reach it. */
const isolatedDatabase = (prefix: string) =>
  Effect.gen(function* () {
    const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
    const name = (yield* unique(prefix)).replaceAll("-", "_")

    const admin = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: base.href, max: 1 })),
      (pool) => Effect.promise(() => pool.end()),
    )

    yield* Effect.acquireRelease(
      Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
      () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
    )
    base.pathname = `/${name}`

    const inside = new URL(base)
    inside.hostname = "host.docker.internal"

    return { name, url: base.href, inside: inside.href }
  }).pipe(Effect.orDie)

const ImagesLive = Layer.effect(
  Images,
  Effect.gen(function* () {
    const build = (version: string) =>
      Effect.gen(function* () {
        const tag = `akter-local-runner:e2e-${version}`

        const built = yield* docker(
          "build",
          "-f",
          `${repository}infra/local/runner/Dockerfile`,
          "--build-arg",
          `RUNNER_VERSION=${version}`,
          "-t",
          tag,
          repository,
        )
        expect(built.code, built.err.slice(-2000)).toBe(0)

        return (yield* docker("image", "inspect", "-f", "{{.Id}}", tag)).out
      })

    const v1 = yield* build("v1")
    const v2 = yield* build("v2")
    expect(v2).not.toBe(v1)

    return { v1, v2 }
  }),
)

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)

const read = <A, I>(response: HttpClientResponse.HttpClientResponse, schema: Schema.Codec<A, I>) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
    Effect.orDie,
  )

const post = (url: string, headers: Record<string, string>, body: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient

    return yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    )
  }).pipe(Effect.orDie)

const get = (url: string) =>
  Effect.gen(function* () {
    return yield* (yield* HttpClient.HttpClient).get(url)
  })

/** A runner container started directly from an image, removed with the scope. */
const startRunner = (options: {
  readonly image: string
  readonly database: string
  readonly keys: string
}) =>
  Effect.gen(function* () {
    const name = yield* unique("akter-e2e-runner")

    yield* Effect.acquireRelease(
      docker(
        "run",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1::8080",
        "-e",
        `DATABASE_URL=${options.database}`,
        "-e",
        `ASSERTION_ISSUER=${issuer}`,
        "-e",
        "ASSERTION_AUDIENCE=image-level",
        "-e",
        `ASSERTION_REGION=${region}`,
        "-e",
        `ASSERTION_KEYS=${options.keys}`,
        options.image,
      ).pipe(Effect.tap((started) => Effect.sync(() => expect(started.code, started.err).toBe(0)))),
      () => docker("rm", "-f", name),
    )

    const mapped = (yield* docker("port", name, "8080/tcp")).out.split("\n")[0]?.split(":").at(-1)
    const origin = `http://127.0.0.1:${mapped}`

    yield* poll(
      `${name} to answer /ready`,
      90,
      get(`${origin}/ready`).pipe(Effect.map((response) => response.status)),
      (status) => status === 200,
    )

    return { name, origin }
  })

layer(Layer.provideMerge(ImagesLive, services), {
  excludeTestServices: true,
  timeout: Duration.minutes(40),
})("example runner image and deployment stack", (it) => {
  it.effect(
    "migrates a fresh database twice, refuses an unreachable one, and serves only edge-asserted callers until SIGTERM drains it",
    () =>
      Effect.gen(function* () {
        const images = yield* Images
        const database = yield* isolatedDatabase("image_stack")
        const key = yield* edgeKey("edge-image-1")

        const migrate = (url: string) =>
          Effect.gen(function* () {
            const name = yield* unique("akter-e2e-migrate")

            return yield* Effect.acquireUseRelease(
              Effect.void,
              () =>
                docker(
                  "run",
                  "--name",
                  name,
                  "-e",
                  `DATABASE_URL=${url}`,
                  images.v1,
                  ...migrateCommand,
                ),
              () => docker("rm", "-f", name),
            )
          })

        const first = yield* migrate(database.inside)
        expect(first.code, first.err).toBe(0)

        const again = yield* migrate(database.inside)
        expect(again.code, again.err).toBe(0)

        expect((yield* migrate("postgres://nobody:nothing@127.0.0.1:1/none")).code).not.toBe(0)

        const runner = yield* startRunner({
          image: images.v1,
          database: database.inside,
          keys: yield* encodeJson({ keys: [key.publicKey] }),
        })

        expect(yield* get(`${runner.origin}/ready`).pipe(Effect.flatMap((r) => r.text))).toBe(
          '{"ready":true}',
        )

        const command = (headers: Record<string, string>) =>
          post(
            `${runner.origin}/actors/Counter/hits/Increment`,
            { "idempotency-key": "k1", ...headers },
            "3",
          )

        expect((yield* command({})).status).toBe(401)
        expect((yield* command({ "durable-assertion": "not.a.jws" })).status).toBe(401)

        const stopped = yield* docker("stop", "-t", "30", runner.name)
        expect(stopped.code).toBe(0)
        expect((yield* docker("inspect", "-f", "{{.State.ExitCode}}", runner.name)).out).toBe("0")

        const logs = yield* docker("logs", runner.name)
        expect(logs.out + logs.err).toContain("drain clean")
      }),
    900_000,
  )

  it.effect(
    "creates a project, deploys, serves commands through the edge, rolls back, and sleeps and wakes",
    () =>
      Effect.gen(function* () {
        const images = yield* Images
        const control = yield* isolatedDatabase("stack_control")
        const app = yield* isolatedDatabase("stack_app")
        const suffix = (yield* unique("u")).replaceAll("-", "")
        const owned = yield* Ref.make<ReadonlyArray<string>>([])
        const edgeLog = yield* Ref.make("")

        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            const ids = yield* Ref.get(owned)
            const names = new Set<string>()

            for (const id of ids)
              for (const found of (yield* docker(
                "ps",
                "-aq",
                "--filter",
                `label=akter.deployment=${id}`,
              )).out
                .split("\n")
                .filter(Boolean))
                names.add(found)

            for (const found of (yield* docker("ps", "-aq", "--filter", "name=akter-migrate-")).out
              .split("\n")
              .filter(Boolean)) {
              const env = yield* docker(
                "inspect",
                "-f",
                "{{range .Config.Env}}{{println .}}{{end}}",
                found,
              )

              if (env.out.includes(`/${app.name}`)) names.add(found)
            }

            if (Exit.isFailure(exit)) {
              yield* Effect.logError(`edge log tail:\n${(yield* Ref.get(edgeLog)).slice(-4000)}`)

              const pool = new Pool({ connectionString: control.url, max: 1 })

              const state = yield* Effect.promise(() =>
                Promise.all(
                  [
                    "SELECT deployment_id, region, url, ready FROM deployment_runner",
                    "SELECT deployment_id, region, requested_at FROM runner_wake",
                    "SELECT id, tier, serving, scale_to_zero, last_activity_at FROM deployment",
                  ].map((query) => pool.query(query)),
                ).finally(() => pool.end()),
              ).pipe(
                Effect.flatMap((results) =>
                  encodeJson(results.map((result) => result.rows.map(String))),
                ),
                Effect.orElseSucceed(() => "control-plane state unreadable"),
              )

              yield* Effect.logError(`runner, wake and deployment rows:\n${state}`)

              for (const found of names) {
                const logs = yield* docker("logs", "--tail", "60", found)

                yield* Effect.logError(`container ${found}:\n${logs.out}\n${logs.err}`)
              }
            }

            for (const found of names) yield* docker("rm", "-f", found)
          }),
        )

        const signing = yield* edgeKey("edge-local-1")
        const jwk = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", signing.privateKey))
        const probe = yield* Effect.sync(() =>
          Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }),
        )
        const edgePort = probe.port ?? 0
        yield* Effect.promise(() => probe.stop(true))
        expect(edgePort).toBeGreaterThan(0)

        const options: ApiOptions = {
          databaseUrl: Redacted.make(control.url),
          secret: Redacted.make("deployment-stack-test-secret-not-for-production"),
          origin: apiOrigin,
          port: 0,
          production: false,
          emailMode: "local",
          emailFrom: "auth@localhost",
          edgeOrigin: `http://127.0.0.1:${edgePort}`,
          deploymentDomain: "localhost",
          runnerPort: 8080,
          runnerIdleSeconds: 45,
          runtimeRequestTimeoutSeconds: 95,
          migrationCommand: migrateCommand,
          runnerEnvironment: {
            DATABASE_URL: app.inside,
            ASSERTION_ISSUER: issuer,
            ASSERTION_KEYS: yield* encodeJson({ keys: [signing.publicKey] }),
          },
        }

        const context = yield* Layer.build(
          infrastructure(options).pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provideMerge(BunCrypto.layer),
          ),
        ).pipe(Effect.orDie)

        const web = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              routes.pipe(
                Layer.provide(Layer.succeedContext(context)),
                Layer.provide(BunHttpServer.layerHttpServices),
              ),
              { disableLogger: true },
            ),
          ),
          (handler) => Effect.promise(() => handler.dispose()),
        )

        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => web.handler(request) }),
          ),
          (running) => Effect.promise(() => running.stop(true)),
        )
        const origin = `http://127.0.0.1:${server.port}`

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

        const edge = yield* spawner.spawn(
          ChildProcess.make("bun", ["apps/edge/src/main.ts"], {
            cwd: repository,
            extendEnv: true,
            env: {
              CONTROL_PLANE_DATABASE_URL: control.url,
              EDGE_ISSUER: issuer,
              EDGE_SIGNING_KEYS: yield* encodeJson([
                { kid: "edge-local-1", x: jwk.x ?? "", d: jwk.d ?? "" },
              ]),
              HOST: "127.0.0.1",
              PORT: String(edgePort),
              EDGE_COLD_START_TIMEOUT: "90 seconds",
            },
          }),
        )

        for (const output of [edge.stdout, edge.stderr])
          yield* output.pipe(
            Stream.decodeText,
            Stream.runForEach((chunk) => Ref.update(edgeLog, (log) => log + chunk)),
            Effect.forkScoped,
          )

        yield* poll(
          "the edge to answer /health",
          60,
          get(`http://127.0.0.1:${edgePort}/health`).pipe(
            Effect.map((response) => response.status),
          ),
          (status) => status === 200,
        )

        const plane = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: control.url, max: 2 })),
          (pool) => Effect.promise(() => pool.end()),
        )
        const sql = <Row extends Record<string, unknown>>(
          statement: string,
          values: Array<string> = [],
        ) =>
          Effect.promise(() => plane.query<Row>(statement, values)).pipe(
            Effect.map((result) => result.rows),
          )

        yield* poll(
          "the edge key to be published",
          30,
          sql("SELECT 1 FROM edge_key WHERE kid = 'edge-local-1'"),
          (rows) => rows.length === 1,
        )
        yield* sql(
          "UPDATE edge_key SET published_at = now() - interval '1 hour' WHERE kid = 'edge-local-1'",
        )

        const client = yield* HttpClient.HttpClient

        const call = (
          path: string,
          init: {
            readonly method?: "GET" | "POST"
            readonly body?: Schema.Json
            readonly cookie?: string
          } = {},
        ) =>
          Effect.gen(function* () {
            const base = HttpClientRequest.make(init.method ?? "GET")(`${origin}${path}`).pipe(
              HttpClientRequest.setHeader("origin", apiOrigin),
            )
            const withCookie =
              init.cookie === undefined
                ? base
                : HttpClientRequest.setHeader(base, "cookie", init.cookie)
            const request =
              init.body === undefined
                ? withCookie
                : yield* HttpClientRequest.bodyJson(init.body)(withCookie)

            return yield* client
              .execute(request)
              .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
          }).pipe(Effect.orDie)

        const signup = (name: string) =>
          Effect.gen(function* () {
            const email = `${name}-${suffix}@example.com`

            const created = yield* call("/auth/sign-up/email", {
              method: "POST",
              body: { name, email, password },
            })
            expect(created.status).toBe(200)

            const [message] = yield* poll(
              `the verification email for ${email}`,
              30,
              sql<{ body: string }>(
                "SELECT body FROM cloud_email_outbox WHERE recipient = $1 AND subject = 'Verify your email' ORDER BY id DESC LIMIT 1",
                [email],
              ),
              (rows) => rows.length === 1,
            )
            const link = new URL(message?.body ?? "")
            expect((yield* call(link.pathname + link.search)).status).toBe(302)

            const login = yield* call("/auth/sign-in/email", {
              method: "POST",
              body: { email, password },
            })
            expect(login.status).toBe(200)

            return Cookies.toCookieHeader(login.cookies)
          })

        const alice = yield* signup("alice")
        const mallory = yield* signup("mallory")

        const membership = yield* call("/api/organizations", {
          method: "POST",
          cookie: alice,
          body: { name: "Stack", slug: `stack-${suffix}` },
        }).pipe(Effect.flatMap((response) => read(response, Cloud.OrganizationMembership)))

        const project = yield* call(`/api/organizations/${membership.organization.id}/projects`, {
          method: "POST",
          cookie: alice,
          body: { name: "Counter app", slug: "counter-app", homeRegion: region },
        }).pipe(Effect.flatMap((response) => read(response, Cloud.Project)))

        const deployments = `/api/projects/${project.id}/deployments`
        const commit = (seed: string) => seed.repeat(40).slice(0, 40)

        const deploy = (seed: string, image: string) =>
          Effect.gen(function* () {
            const created = yield* call(deployments, {
              method: "POST",
              cookie: alice,
              body: { environment: "production", commitSha: commit(seed) },
            })
            expect(created.status).toBe(200)

            const { id } = yield* read(created, Cloud.DeploymentDetail)
            yield* Ref.update(owned, (ids) => [...ids, id])

            const recorded = yield* call(`${deployments}/${id}/build`, {
              method: "POST",
              cookie: alice,
              body: { image, commitSha: commit(seed), environmentSnapshot: { FLAVOR: seed } },
            })
            expect(recorded.status).toBe(200)

            return id
          })

        const detail = (id: string) =>
          call(`${deployments}/${id}`, { cookie: alice }).pipe(
            Effect.flatMap((response) => read(response, Cloud.DeploymentDetail)),
          )

        const settled = (id: string) =>
          poll(
            `deployment ${id} to settle`,
            300,
            detail(id),
            (found) => found.status !== "in-progress",
          )

        const statusOf = (id: string) => detail(id).pipe(Effect.map((found) => found.status))

        const sendAs = (cookie: string | undefined, payload: number, commandId?: string) =>
          call(`/api/projects/${project.id}/environments/production/runtime/commands`, {
            method: "POST",
            cookie,
            body:
              commandId === undefined
                ? { address: "Counter/hits", command: "Increment", payload }
                : { address: "Counter/hits", command: "Increment", payload, commandId },
          })

        const send = (payload: number, commandId?: string) =>
          sendAs(alice, payload, commandId).pipe(
            Effect.tap((response) =>
              response.text.pipe(
                Effect.orDie,
                Effect.tap((body) => Effect.sync(() => expect(response.status, body).toBe(200))),
              ),
            ),
            Effect.flatMap((response) => read(response, Cloud.CommandSent)),
          )

        const sendEventually = (payload: number, commandId: string) =>
          Effect.gen(function* () {
            const tries = yield* Ref.make(0)

            const response = yield* sendAs(alice, payload, commandId).pipe(
              Effect.tap(() => Ref.update(tries, (count) => count + 1)),
              Effect.filterOrFail((answer) => answer.status !== 503),
              Effect.retry({ schedule: Schedule.spaced("1 second"), times: 150 }),
              Effect.mapError(() => new Error("the woken deployment kept answering 503")),
              Effect.orDie,
            )
            const body = yield* response.text.pipe(Effect.orDie)
            expect(response.status, body).toBe(200)

            return {
              sent: yield* read(response, Cloud.CommandSent),
              attempts: yield* Ref.get(tries),
            }
          })

        const running = (id: string) =>
          docker(
            "ps",
            "-q",
            "--filter",
            `label=akter.deployment=${id}`,
            "--filter",
            "status=running",
          ).pipe(Effect.map((found) => found.out.split("\n").filter(Boolean)))

        const first = yield* deploy("a", images.v1)
        expect(yield* settled(first)).toMatchObject({
          id: first,
          status: "live",
          rolledBackFrom: null,
        })
        expect((yield* detail(first)).steps.map((step) => step.status)).not.toContain("failed")

        const environments = yield* call(`/api/projects/${project.id}/environments`, {
          cookie: alice,
        }).pipe(Effect.flatMap((response) => read(response, Schema.Array(Cloud.Environment))))
        expect(environments.find((env) => env.name === "production")?.currentDeploymentId).toBe(
          first,
        )

        const counted = yield* send(3)
        expect(counted).toMatchObject({
          replayed: false,
          result: { count: 3, version: "v1", caller: "akter-control-plane" },
        })
        expect(yield* send(3, counted.commandId)).toMatchObject({
          commandId: counted.commandId,
          replayed: true,
          result: { count: 3, version: "v1" },
        })

        expect((yield* sendAs(undefined, 1)).status).toBe(401)
        expect((yield* sendAs(mallory, 1)).status).toBe(403)
        expect((yield* call(`${deployments}/${first}`, { cookie: mallory })).status).toBe(403)

        yield* sql("UPDATE deployment SET tier = 'pro', scale_to_zero = false WHERE id = $1", [
          first,
        ])
        const warm = yield* running(first)
        expect(warm).toHaveLength(1)

        const second = yield* deploy("b", images.v2)
        expect(yield* settled(second)).toMatchObject({ id: second, status: "live" })
        expect(yield* statusOf(first)).toBe("drained")

        const replacement = yield* running(second)
        expect(replacement).toHaveLength(1)

        const instant = (container: string, field: "StartedAt" | "FinishedAt") =>
          docker("inspect", "-f", `{{.State.${field}}}`, container).pipe(
            Effect.map((found) => DateTime.toEpochMillis(DateTime.makeUnsafe(found.out))),
          )

        yield* poll(
          "the replaced deployment's warm runner to stop",
          90,
          running(first),
          (found) => found.length === 0,
        )
        expect(yield* instant(warm[0] ?? "", "StartedAt")).toBeLessThan(
          yield* instant(replacement[0] ?? "", "StartedAt"),
        )
        expect(yield* instant(replacement[0] ?? "", "StartedAt")).toBeLessThan(
          yield* instant(warm[0] ?? "", "FinishedAt"),
        )
        expect((yield* send(4)).result).toMatchObject({ count: 7, version: "v2" })

        const broken = yield* deploy("c", `sha256:${"0".repeat(64)}`)
        expect(yield* settled(broken)).toMatchObject({ id: broken, status: "failed" })
        expect(yield* statusOf(second)).toBe("live")
        expect((yield* send(1)).result).toMatchObject({ count: 8, version: "v2" })

        const rollback = yield* call(`${deployments}/${first}/rollback`, {
          method: "POST",
          cookie: alice,
        })
        expect(rollback.status).toBe(200)

        const rolledBack = yield* read(rollback, Cloud.DeploymentDetail)
        yield* Ref.update(owned, (ids) => [...ids, rolledBack.id])
        expect(rolledBack.rolledBackFrom).toBe(first)
        expect(yield* settled(rolledBack.id)).toMatchObject({
          status: "live",
          rolledBackFrom: first,
        })
        expect(yield* statusOf(second)).toBe("rolled-back")
        expect(yield* statusOf(first)).toBe("drained")
        expect((yield* send(2)).result).toMatchObject({ count: 10, version: "v1" })
        expect(yield* send(3, counted.commandId)).toMatchObject({
          replayed: true,
          result: { count: 3, version: "v1" },
        })

        const issued = yield* Clock.currentTimeMillis
        const wakeId = `v1.${issued}.${issued + 86_400_000}.${yield* (yield* Crypto.Crypto).randomUUIDv4}`
        const awake = yield* running(rolledBack.id)
        expect(awake).toHaveLength(1)

        yield* poll(
          "the idle deployment to sleep",
          120,
          running(rolledBack.id),
          (found) => found.length === 0,
        )
        expect(
          yield* sql("SELECT 1 FROM deployment_runner WHERE deployment_id = $1", [rolledBack.id]),
        ).toEqual([])

        const slept = yield* docker("logs", awake[0] ?? "")
        expect((yield* docker("inspect", "-f", "{{.State.ExitCode}}", awake[0] ?? "")).out).toBe(
          "0",
        )
        expect(slept.out + slept.err).toContain("drain clean")

        const woke = yield* sendEventually(5, wakeId)
        expect(woke.sent).toMatchObject({
          commandId: wakeId,
          replayed: false,
          result: { count: 15, version: "v1" },
        })
        expect(yield* send(5, wakeId)).toMatchObject({
          replayed: true,
          result: { count: 15, version: "v1" },
        })

        const woken = yield* running(rolledBack.id)
        expect(woken).toHaveLength(1)
        expect(woken[0]).not.toBe(awake[0])
        expect(yield* send(3, counted.commandId)).toMatchObject({
          replayed: true,
          result: { count: 3, version: "v1" },
        })
      }),
    1_500_000,
  )
})
