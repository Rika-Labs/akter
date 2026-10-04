import * as Cloud from "@akter/cloud-api"
import { edgeKey } from "@rikalabs/akter/testing"
import { BunCrypto, BunHttpServer, BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
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
import { Sse } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PlatformError } from "effect/PlatformError"
import { Pool } from "pg"
import type { ApiOptions } from "./config.ts"
import { infrastructure, routes } from "./server.ts"
import { Repository } from "./repository.ts"

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

/**
 * The two runner images, each under a tag unique to this run and untagged
 * when the layer closes, because a fixed tag shared with a concurrent run on
 * the same daemon is retagged under it and its image can be removed mid-run.
 */
const ImagesLive = Layer.effect(
  Images,
  Effect.gen(function* () {
    const build = (version: string) =>
      Effect.gen(function* () {
        const tag = yield* Effect.acquireRelease(
          unique(`akter-local-runner:e2e-${version}`),
          (made) => docker("image", "rm", made),
        )

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

/**
 * A control plane and a real edge process over fresh databases, with a
 * verified owner (alice), a stranger (mallory) and alice's project. A
 * `localBuild` makes the control plane build each new deployment's image
 * itself. The scope removes the containers, and the images a local build
 * made, of every deployment the scenario records in `owned`.
 */
const startStack = (localBuild?: ApiOptions["localBuild"]) =>
  Effect.gen(function* () {
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

        if (localBuild !== undefined)
          for (const id of ids) yield* docker("image", "rm", "--force", `akter-build:${id}`)
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
      localBuild,
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
        Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (request) => web.handler(request, context),
        }),
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
          EDGE_PUBLICATION_LEAD: "0 seconds",
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
      get(`http://127.0.0.1:${edgePort}/health`).pipe(Effect.map((response) => response.status)),
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
    const aliceId = yield* call("/api/me", { cookie: alice }).pipe(
      Effect.flatMap((response) => read(response, Cloud.Me)),
      Effect.map((me) => me.user?.id ?? ""),
    )
    expect(aliceId).not.toBe("")

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
      poll(`deployment ${id} to settle`, 300, detail(id), (found) => found.status !== "in-progress")

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

    return {
      app,
      origin,
      context,
      owned,
      suffix,
      edgePort,
      sql,
      call,
      alice,
      aliceId,
      mallory,
      membership,
      project,
      deployments,
      commit,
      deploy,
      detail,
      settled,
      statusOf,
      sendAs,
      send,
      sendEventually,
      running,
    }
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
    "creates a project, deploys, serves commands through the edge attributed to the signed-in user, inspects the actor, refuses a forged attribution, rolls back, and sleeps and wakes",
    () =>
      Effect.gen(function* () {
        const images = yield* Images
        const {
          app,
          context,
          owned,
          suffix,
          edgePort,
          sql,
          call,
          alice,
          aliceId,
          mallory,
          membership,
          project,
          deployments,
          deploy,
          detail,
          settled,
          statusOf,
          sendAs,
          send,
          sendEventually,
          running,
        } = yield* startStack()

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

        const fresh = `Counter/first-${suffix}`
        const jobsOf = (address: string) =>
          call(
            `/api/projects/${project.id}/environments/production/runtime/actors/${address}/jobs`,
            { cookie: alice },
          )
        expect((yield* jobsOf(fresh)).status).toBe(404)

        const firstKey = yield* (yield* Crypto.Crypto).randomUUIDv4
        const sendFirst = call(
          `/api/projects/${project.id}/environments/production/runtime/commands`,
          {
            method: "POST",
            cookie: alice,
            body: { address: fresh, command: "Increment", payload: 2, commandId: firstKey },
          },
        ).pipe(
          Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
          Effect.flatMap((response) => read(response, Cloud.CommandSent)),
        )
        const created = yield* sendFirst
        expect(created).toMatchObject({
          replayed: false,
          result: { count: 2, version: "v1", caller: `user:${aliceId}` },
        })
        expect(yield* sendFirst).toMatchObject({
          commandId: created.commandId,
          replayed: true,
          result: { count: 2, version: "v1" },
        })
        const listed = yield* jobsOf(fresh)
        expect(listed.status).toBe(200)
        expect(yield* read(listed, Schema.Array(Cloud.ActorJob))).toEqual([])

        expect(
          (yield* call(
            `/api/projects/${project.id}/environments/production/runtime/actors/Counter/hits/jobs`,
            { cookie: alice },
          )).status,
        ).toBe(404)

        expect((yield* sendAs(undefined, 1)).status).toBe(401)
        expect((yield* sendAs(mallory, 1)).status).toBe(403)

        expect(
          (yield* call(
            `/api/projects/${project.id}/environments/production/runtime/actors/Counter/hits/jobs`,
            { cookie: alice },
          )).status,
        ).toBe(404)

        const clientKey = yield* (yield* Crypto.Crypto).randomUUIDv4
        const counted = yield* send(3, clientKey)
        expect(counted).toMatchObject({
          replayed: false,
          result: { count: 3, version: "v1", caller: `user:${aliceId}` },
        })
        expect(counted.commandId).not.toBe(clientKey)
        expect(counted.commandId).toMatch(/^v1\./u)
        expect(yield* send(3, clientKey)).toMatchObject({
          commandId: counted.commandId,
          replayed: true,
          result: { count: 3, version: "v1" },
        })
        const conflict = yield* sendAs(alice, 13, clientKey)
        expect(conflict.status).toBe(409)
        expect(yield* read(conflict, Cloud.Conflict)).toMatchObject({
          message: "The idempotency key was already used for another payload",
        })

        const inspect = (address: string, cookie = alice) =>
          call(`/api/projects/${project.id}/environments/production/runtime/actors/${address}`, {
            cookie,
          })
        const applicationRows = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: app.url, max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        )
        const generationOf = (id: string) =>
          Effect.promise(() =>
            applicationRows.query<{ generation: number }>(
              "SELECT generation::int AS generation FROM durable.actors WHERE tenant_id = 'default' AND actor_type = 'Counter' AND actor_id = $1",
              [id],
            ),
          ).pipe(Effect.map((result) => result.rows[0]?.generation))

        const hits = yield* inspect("Counter/hits")
        expect(hits.status).toBe(200)
        const inspected = yield* read(hits, Cloud.ActorInspector)
        const generation = yield* generationOf("hits")
        expect(generation).toBeGreaterThanOrEqual(1)
        const [committed] = yield* Effect.promise(() =>
          applicationRows.query<{ at: string }>(
            "SELECT committed_at_ms::text AS at FROM actor_receipts WHERE command_id = $1",
            [counted.commandId],
          ),
        ).pipe(Effect.map((result) => result.rows))
        const [serving] = yield* running(first)
        expect(inspected).toEqual({
          address: "Counter/hits",
          state: { count: 3 },
          turn: null,
          tables: null,
          receipts: [
            {
              commandId: counted.commandId,
              command: "Increment",
              result: "Success",
              caller: { kind: "user", subject: `user:${aliceId}`, source: null },
              at: DateTime.makeUnsafe(Number(committed?.at)),
              expiresAt: DateTime.makeUnsafe(Number(counted.commandId.split(".")[2])),
              replayed: false,
            },
          ],
          events: [],
          jobs: [],
          connections: { sockets: 0, feedCursor: null },
          properties: {
            status: "awake",
            type: "Counter",
            generation,
            runner: serving,
            region,
            tenant: "default",
            mailboxDepth: 0,
          },
          timeline: [],
        })
        const unknown = yield* inspect(`Counter/never-${suffix}`)
        expect(unknown.status).toBe(404)
        expect(yield* read(unknown, Cloud.NotFound)).toMatchObject({
          resource: "actor",
          id: `Counter/never-${suffix}`,
        })
        expect((yield* inspect("Counter/hits", mallory)).status).toBe(403)

        const edgeOrigin = `http://127.0.0.1:${edgePort}`
        const host = `${project.id.replaceAll("_", "-")}-production.localhost`
        const tenantKey = `dak_${(yield* unique("forger")).replaceAll("-", "")}`
        yield* sql(
          "INSERT INTO hosted_api_key (key_hash, deployment_id, tenant, subject) VALUES ($1, $2, 'default', 'tenant-app-user')",
          [new Bun.CryptoHasher("sha256").update(tenantKey).digest("hex"), first],
        )
        const asTenant = { host, authorization: `Bearer ${tenantKey}` }
        const minted = yield* (yield* HttpClient.HttpClient)
          .execute(
            HttpClientRequest.post(`${edgeOrigin}/command-ids`).pipe(
              HttpClientRequest.setHeaders(asTenant),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              read(response, Schema.Struct({ commandId: Schema.String })),
            ),
            Effect.orDie,
          )
        const forged = yield* post(
          `${edgeOrigin}/actors/Counter/forged/Increment`,
          {
            ...asTenant,
            "idempotency-key": minted.commandId,
            "akter-on-behalf-of": `user:${aliceId}`,
          },
          "1",
        )
        expect(forged.status).toBe(200)
        expect(
          yield* read(forged, Schema.Struct({ count: Schema.Int, caller: Schema.String })),
        ).toEqual({
          count: 1,
          caller: "tenant-app-user",
        })

        const duplicateKey = yield* (yield* Crypto.Crypto).randomUUIDv4
        const duplicates = yield* Effect.forEach(
          [0, 1],
          () =>
            call(`/api/projects/${project.id}/environments/production/runtime/commands`, {
              method: "POST",
              cookie: alice,
              body: {
                address: "Counter/concurrent",
                command: "Increment",
                payload: 7,
                commandId: duplicateKey,
              },
            }).pipe(Effect.flatMap((response) => read(response, Cloud.CommandSent))),
          { concurrency: 2 },
        )
        expect(duplicates[0]?.commandId).toBe(duplicates[1]?.commandId)
        expect(
          duplicates
            .map((value) => value.replayed)
            .sort((left, right) => Number(left) - Number(right)),
        ).toEqual([false, true])
        const firstRunners = yield* running(first)
        expect(firstRunners).toHaveLength(1)
        expect(duplicates.map((value) => value.result)).toEqual([
          { count: 7, version: "v1", runner: firstRunners[0], caller: `user:${aliceId}` },
          { count: 7, version: "v1", runner: firstRunners[0], caller: `user:${aliceId}` },
        ])

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
        expect(yield* send(3, clientKey)).toMatchObject({
          replayed: true,
          result: { count: 3, version: "v1" },
        })

        const wakeId = yield* (yield* Crypto.Crypto).randomUUIDv4
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

        const rewoken = yield* read(yield* inspect("Counter/hits"), Cloud.ActorInspector)
        const regenerated = yield* generationOf("hits")
        expect(regenerated).toBeGreaterThan(generation ?? 0)
        expect(rewoken).toMatchObject({
          state: { count: 15 },
          properties: { generation: regenerated, type: "Counter", tenant: "default" },
        })
        expect(rewoken.receipts.map((receipt) => receipt.commandId)).toContain(woke.sent.commandId)
        expect(woke.sent.commandId).not.toBe(wakeId)
        expect(yield* send(3, clientKey)).toMatchObject({
          replayed: true,
          result: { count: 3, version: "v1" },
        })

        const commands = Context.get(context, Repository)
        yield* sql(
          `UPDATE cloud_command_idempotency SET expires_at_ms =
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint - 1000
          WHERE command_id = $1`,
          [counted.commandId],
        )
        const expiredReplies = yield* Effect.all(
          [
            commands.sweepCommands,
            Effect.forEach([0, 1, 2, 3], () => sendAs(alice, 3, clientKey), { concurrency: 4 }),
          ],
          { concurrency: 2 },
        )
        for (const response of expiredReplies[1]) {
          expect(response.status).toBe(410)
          expect(yield* read(response, Cloud.CommandExpired)).toEqual(
            Cloud.CommandExpired.make({ commandId: clientKey }),
          )
        }
        yield* sql(
          `UPDATE cloud_command_idempotency SET expires_at_ms =
          (extract(epoch FROM clock_timestamp() - interval '31 days') * 1000)::bigint
          WHERE organization_id = $1 AND project_id = $2 AND command_id IS NULL`,
          [membership.organization.id, project.id],
        )
        const reusedReplies = yield* Effect.all(
          [
            commands.sweepCommands,
            Effect.forEach([0, 1, 2, 3], () => sendAs(alice, 3, clientKey), { concurrency: 4 }),
          ],
          { concurrency: 2 },
        )
        for (const response of reusedReplies[1]) {
          expect([200, 410]).toContain(response.status)
          if (response.status === 200)
            expect(yield* read(response, Cloud.CommandSent)).toMatchObject({
              result: { count: 18, version: "v1" },
            })
        }
        const reused = yield* send(3, clientKey)
        expect(reused.commandId).not.toBe(counted.commandId)
        expect(reused.result).toMatchObject({ count: 18, version: "v1" })
      }),
    1_500_000,
  )

  it.effect(
    "reads the runners' overview, actor types and instances, receipts with their callers, events, timeline, jobs, dead letters, workflows and timers through the edge, and refuses another organization",
    () =>
      Effect.gen(function* () {
        const images = yield* Images
        const { app, call, alice, aliceId, mallory, suffix, project, deploy, settled, detail } =
          yield* startStack()

        const deployed = yield* deploy("a", images.v1)
        expect(yield* settled(deployed)).toMatchObject({ status: "live" })

        const runtime = `/api/projects/${project.id}/environments/production/runtime`
        const send = (address: string, command: string, payload: Schema.Json) =>
          call(`${runtime}/commands`, {
            method: "POST",
            cookie: alice,
            body: { address, command, payload },
          })
        const sent = (address: string, command: string, payload: Schema.Json) =>
          send(address, command, payload).pipe(
            Effect.tap((response) =>
              response.text.pipe(
                Effect.orDie,
                Effect.tap((body) => Effect.sync(() => expect(response.status, body).toBe(200))),
              ),
            ),
            Effect.flatMap((response) => read(response, Cloud.CommandSent)),
          )

        const five = yield* sent("Ledger/a", "Record", 5)
        const seven = yield* sent("Ledger/a", "Record", 7)
        const one = yield* sent("Ledger/b", "Record", 1)
        expect([five.result, seven.result, one.result]).toEqual([5, 12, 1])
        const adjusted = yield* sent("Ledger/a", "Adjust", 3)
        expect(adjusted.result).toBe(15)
        yield* sent("Ledger/b", "Queue", 4)
        const noted = yield* sent("Ledger/a", "Note", "hello")
        const refusal = yield* send("Ledger/a", "Refuse", "no")
        expect(refusal.status).toBe(422)
        const refused = yield* read(refusal, Cloud.CommandFailed)
        expect(refused.errorTag).toBe("Refused")
        const opened = yield* sent("Ledger/a", "OpenReview", "ada")
        const executionId = yield* Schema.decodeUnknownEffect(Schema.String)(opened.result).pipe(
          Effect.orDie,
        )
        const counted = yield* sent("Counter/solo", "Increment", 2)

        const applicationRows = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: app.url, max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        )
        const rows = <Row extends Record<string, unknown>>(
          statement: string,
          values: Array<string> = [],
        ) =>
          Effect.promise(() => applicationRows.query<Row>(statement, values)).pipe(
            Effect.map((result) => result.rows),
          )

        yield* poll(
          "every Settle job to dead-letter and the Retry job to fail its first attempt",
          90,
          rows<{ dead: number; retrying: number; queued: number }>(
            "SELECT (SELECT count(*)::int FROM durable.dead_letters WHERE tenant_id = 'default') AS dead, (SELECT count(*)::int FROM durable.jobs WHERE tenant_id = 'default' AND job = 'Retry' AND attempts > 0) AS retrying, (SELECT count(*)::int FROM durable.jobs WHERE tenant_id = 'default' AND job = 'Later' AND attempts = 0) AS queued",
          ),
          ([found]) => found?.dead === 3 && found.retrying === 1 && found.queued === 1,
        )
        yield* poll(
          "the review to suspend on its clock and the other two runs to finish",
          90,
          rows<{ workflow: string; status: string }>(
            "SELECT workflow, status FROM durable.workflows WHERE tenant_id = 'default' ORDER BY workflow",
          ),
          (found) =>
            found.map((row) => `${row.workflow}:${row.status}`).join(",") ===
            "Doomed:finished,Quick:finished,Review:suspended",
        )

        const get = <A, I>(path: string, schema: Schema.Codec<A, I>, cookie = alice) =>
          call(`${runtime}${path}`, { cookie }).pipe(
            Effect.tap((response) =>
              response.text.pipe(
                Effect.orDie,
                Effect.tap((body) => Effect.sync(() => expect(response.status, body).toBe(200))),
              ),
            ),
            Effect.flatMap((response) => read(response, schema)),
          )
        const every = <A, I>(path: string, item: Schema.Codec<A, I>) =>
          Effect.gen(function* () {
            const items: Array<A> = []
            let cursor: string | null = null

            for (let page = 0; page < 50; page++) {
              const separator = path.includes("?") ? "&" : "?"
              const found: {
                readonly items: ReadonlyArray<A>
                readonly nextCursor: string | null
              } = yield* get(
                cursor === null ? path : `${path}${separator}cursor=${cursor}`,
                Cloud.Page(item),
              )
              items.push(...found.items)

              if (found.nextCursor === null) return items

              cursor = found.nextCursor
            }

            return yield* Effect.die(new Error(`${path} never reached its last page`))
          })
        const millis = (at: DateTime.Utc | null) =>
          at === null ? null : DateTime.toEpochMillis(at)
        yield* poll(
          "the cluster to list no runner but the serving one, so live reads cover the environment",
          120,
          call(`${runtime}/connections`, { cookie: alice }).pipe(
            Effect.map((response) => response.status),
          ),
          (status) => status === 200,
        )
        const byCodeUnit = (left: string, right: string) =>
          left < right ? -1 : left > right ? 1 : 0
        const asAlice = { kind: "user", subject: `user:${aliceId}`, source: null }

        const [counts] = yield* rows<{ actors: number; jobs: number; timers: number }>(
          "SELECT (SELECT count(*)::int FROM durable.actors WHERE tenant_id = 'default') AS actors, (SELECT count(*)::int FROM durable.jobs WHERE tenant_id = 'default') AS jobs, (SELECT count(*)::int FROM durable.timers WHERE tenant_id = 'default') AS timers",
        )
        expect(counts?.actors).toBe(3)
        expect(counts?.jobs).toBe(2)
        const overview = yield* get("/overview", Cloud.Overview)
        expect({
          ...overview,
          commands: null,
          actors: { ...overview.actors, awake: null },
          health: {
            ...overview.health,
            maxMailbox: null,
            lastDeployAt: millis(overview.health.lastDeployAt),
          },
        }).toEqual({
          commands: null,
          actors: { awake: null, total: 3 },
          jobs: { inFlight: 2, donePerHour: null },
          deadLettersByJobType: [{ jobName: "Settle", count: 3 }],
          throughput: null,
          p99: null,
          health: {
            runners: null,
            databaseCpuPercent: null,
            maxMailbox: null,
            parkedSockets: null,
            outboxLagP99Ms: null,
            lastDeployAt: DateTime.toEpochMillis((yield* detail(deployed)).createdAt),
          },
          recentDeployments: null,
        })
        const awakeOverall = overview.actors.awake ?? -1
        expect(Number.isInteger(awakeOverall) && awakeOverall >= 0 && awakeOverall <= 3).toBe(true)
        expect(overview.health.maxMailbox).toEqual({ depth: 0, actor: null })
        const liveCommands = overview.commands
        expect(liveCommands).not.toBeNull()
        expect(liveCommands?.perSecond).toBeGreaterThanOrEqual(0)
        expect(liveCommands?.series24h.length).toBeGreaterThanOrEqual(1)
        expect(liveCommands?.series24h.length).toBeLessThanOrEqual(24)
        expect(liveCommands?.series24h.every((point) => point.value >= 0)).toBe(true)
        expect(liveCommands?.p50Ms).toBeGreaterThanOrEqual(0)
        expect(liveCommands?.p99Ms).toBeGreaterThanOrEqual(liveCommands?.p50Ms ?? 0)
        expect(yield* get("/sidebar-counts", Cloud.SidebarCounts)).toEqual({
          actorTypes: 2,
          openDeadLetters: 3,
        })

        const summary = (name: string, instances: number) => ({
          name,
          commands: null,
          instances,
          awake: null,
          commandsPerSecond: null,
          p99Ms: null,
          maxMailbox: null,
        })
        const durable = (found: Cloud.ActorTypeSummary) => ({
          ...found,
          awake: null,
          commandsPerSecond: null,
          p99Ms: null,
          maxMailbox: null,
        })
        const listedTypes = yield* get("/actor-types", Schema.Array(Cloud.ActorTypeSummary))
        expect(listedTypes.map(durable)).toEqual([summary("Counter", 1), summary("Ledger", 2)])
        for (const found of [
          ...listedTypes,
          yield* get("/actor-types/Ledger", Cloud.ActorTypeSummary),
        ]) {
          expect(found.awake !== null && found.awake >= 0 && found.awake <= found.instances).toBe(
            true,
          )
          expect(found.commandsPerSecond).toBeGreaterThanOrEqual(0)
          expect(found.p99Ms).toBeGreaterThanOrEqual(0)
          expect(found.maxMailbox).toBe(0)
        }
        expect(durable(yield* get("/actor-types/Ledger", Cloud.ActorTypeSummary))).toEqual(
          summary("Ledger", 2),
        )
        const missingType = yield* call(`${runtime}/actor-types/Missing`, { cookie: alice })
        expect(missingType.status).toBe(404)
        expect(yield* read(missingType, Cloud.NotFound)).toMatchObject({
          resource: "actor-type",
          id: "Missing",
        })

        const generations = yield* rows<{ actor_id: string; generation: number }>(
          "SELECT actor_id, generation::int AS generation FROM durable.actors WHERE tenant_id = 'default' AND actor_type = 'Ledger'",
        )
        const lastCommands = yield* rows<{ actor_id: string; command: string; at: string }>(
          "SELECT DISTINCT ON (actor_id) actor_id, command, committed_at_ms::text AS at FROM actor_receipts WHERE tenant_id = 'default' AND actor_type = 'Ledger' AND committed_at_ms IS NOT NULL ORDER BY actor_id, committed_at_ms DESC, command_id COLLATE \"C\" DESC",
        )
        const instances = yield* every("/actor-types/Ledger/instances?limit=1", Cloud.ActorInstance)
        expect(
          instances.map((instance) => ({
            ...instance,
            status: null,
            lastActivityAt: millis(instance.lastActivityAt),
          })),
        ).toEqual(
          ["a", "b"].map((key) => ({
            key,
            status: null,
            lastCommand: lastCommands.find((row) => row.actor_id === key)?.command,
            lastActivityAt: Number(lastCommands.find((row) => row.actor_id === key)?.at),
            generation: generations.find((row) => row.actor_id === key)?.generation,
          })),
        )
        expect(
          instances.every((instance) => instance.status === "awake" || instance.status === "idle"),
        ).toBe(true)
        expect(
          (yield* call(`${runtime}/actor-types/Ledger/instances?status=awake`, { cookie: alice }))
            .status,
        ).toBe(501)

        const search = (q: string) =>
          get(`/search?q=${encodeURIComponent(q)}`, Schema.Array(Cloud.SearchResult)).pipe(
            Effect.map((results) => results.map((result) => `${result.kind} ${result.id}`)),
          )
        expect(yield* search("Ledger/")).toEqual(["actor Ledger/a", "actor Ledger/b"])
        expect(yield* search("Led")).toEqual([
          "actor-type Ledger",
          "actor Ledger/a",
          "actor Ledger/b",
        ])
        expect(yield* search("Counter/so")).toEqual(["actor Counter/solo"])
        expect(yield* search("Ledger/z")).toEqual([])

        const receiptRows = yield* rows<{
          actor_type: string
          actor_id: string
          command_id: string
          command: string
          outcome_tag: string
          expires_at_ms: string
          committed_at_ms: string
          duration_ms: string
        }>(
          "SELECT actor_type, actor_id, command_id, command, outcome_tag, expires_at_ms::text, committed_at_ms::text, duration_ms::text FROM durable.receipts WHERE tenant_id = 'default'",
        )
        const receiptAt = (commandId: string) =>
          Number(receiptRows.find((row) => row.command_id === commandId)?.committed_at_ms)
        const receiptDuration = (commandId: string) =>
          Number(receiptRows.find((row) => row.command_id === commandId)?.duration_ms)
        const newestFirst = receiptRows.toSorted(
          (left, right) =>
            Number(right.expires_at_ms) - Number(left.expires_at_ms) ||
            byCodeUnit(left.actor_type, right.actor_type) ||
            byCodeUnit(left.actor_id, right.actor_id) ||
            byCodeUnit(left.command_id, right.command_id),
        )
        const ledgerA = newestFirst.filter(
          (row) => row.actor_type === "Ledger" && row.actor_id === "a",
        )
        const sentToA = new Map([
          [five.commandId, "Record"],
          [seven.commandId, "Record"],
          [adjusted.commandId, "Adjust"],
          [noted.commandId, "Note"],
          [refused.commandId, "Refuse"],
          [opened.commandId, "OpenReview"],
        ])
        expect(ledgerA.map((row) => row.command_id)).toEqual(
          expect.arrayContaining([...sentToA.keys()]),
        )

        const receipts = yield* every("/actors/Ledger/a/receipts?limit=2", Cloud.Receipt)
        expect(
          receipts.map((receipt) => ({
            ...receipt,
            caller: sentToA.has(receipt.commandId) ? receipt.caller : null,
            at: millis(receipt.at),
            expiresAt: millis(receipt.expiresAt),
          })),
        ).toEqual(
          ledgerA.map((row) => ({
            commandId: row.command_id,
            command: row.command,
            result: row.outcome_tag,
            caller: sentToA.has(row.command_id) ? asAlice : null,
            at: Number(row.committed_at_ms),
            expiresAt: Number(row.expires_at_ms),
            replayed: false,
          })),
        )
        for (const receipt of receipts)
          if (sentToA.has(receipt.commandId)) {
            expect(receipt.command).toBe(sentToA.get(receipt.commandId))
            expect(millis(receipt.expiresAt)).toBe(Number(receipt.commandId.split(".")[2]))
          } else expect(receipt.caller?.kind).toBe("system")
        expect(receipts.find((receipt) => receipt.commandId === refused.commandId)?.result).toBe(
          "Failure",
        )

        const events = yield* rows<{
          sequence: number
          event: string
          command_id: string
          emitted_at_ms: string
        }>(
          "SELECT sequence::int AS sequence, event, command_id, emitted_at_ms::text FROM durable.events WHERE tenant_id = 'default' AND actor_type = 'Ledger' AND actor_id = 'a' ORDER BY sequence DESC",
        )
        expect(events.map((event) => [event.sequence, event.event, event.command_id])).toEqual([
          [4, "Adjusted", adjusted.commandId],
          [3, "Recorded", adjusted.commandId],
          [2, "Recorded", seven.commandId],
          [1, "Recorded", five.commandId],
        ])
        const emitted = (sequence: number) =>
          Number(events.find((event) => event.sequence === sequence)?.emitted_at_ms)

        const listedEvents = (yield* get(
          "/actors/Ledger/a/events",
          Schema.Array(Cloud.ActorEvent),
        )).map((event) => ({ ...event, emittedAt: millis(event.emittedAt) }))
        expect(listedEvents).toEqual([
          { name: "Adjusted", cursor: "4", emittedAt: emitted(4), subscribers: 0 },
          { name: "Recorded", cursor: "3", emittedAt: emitted(3), subscribers: 0 },
        ])

        const expectedTimeline = events.flatMap((event, index) => {
          const entry = {
            kind: "event",
            label: event.event,
            detail: event.command_id,
            at: Number(event.emitted_at_ms),
            caller: asAlice,
          }
          if (events[index + 1]?.command_id === event.command_id) return [entry]
          const own = events.filter((other) => other.command_id === event.command_id)
          return [
            entry,
            {
              kind: "command",
              label: sentToA.get(event.command_id),
              detail: event.command_id,
              at: Math.min(...own.map((other) => Number(other.emitted_at_ms))),
              caller: asAlice,
            },
          ]
        })
        expect(expectedTimeline.map((entry) => `${entry.kind} ${String(entry.label)}`)).toEqual([
          "event Adjusted",
          "event Recorded",
          "command Adjust",
          "event Recorded",
          "command Record",
          "event Recorded",
          "command Record",
        ])
        const timeline = yield* every("/actors/Ledger/a/timeline?limit=3", Cloud.ActorTimelineEntry)
        expect(timeline.map((entry) => ({ ...entry, at: millis(entry.at) }))).toEqual(
          expectedTimeline,
        )

        const inspected = yield* get("/actors/Ledger/a", Cloud.ActorInspector)
        expect(inspected.receipts).toEqual(receipts)
        expect(inspected.timeline).toEqual(timeline)
        expect(
          inspected.events.map((event) => ({ ...event, emittedAt: millis(event.emittedAt) })),
        ).toEqual(listedEvents)
        expect(inspected.state).toEqual({ total: 15 })

        const missingActor = yield* call(`${runtime}/actors/Ledger/missing/receipts`, {
          cookie: alice,
        })
        expect(missingActor.status).toBe(404)
        expect(yield* read(missingActor, Cloud.NotFound)).toMatchObject({
          resource: "actor",
          id: "Ledger/missing",
        })
        const tampered = (expiresAtMs: number) =>
          Buffer.from(
            JSON.stringify({ actorType: "Ledger", actorId: "a", expiresAtMs, commandId: "x" }),
          ).toString("base64url")
        for (const cursor of ["not-ours", tampered(1.5), tampered(1e21), tampered(-1)]) {
          const refusedCursor = yield* call(
            `${runtime}/actors/Ledger/a/receipts?cursor=${cursor}`,
            { cookie: alice },
          )
          expect([cursor, refusedCursor.status]).toEqual([cursor, 404])
          expect(yield* read(refusedCursor, Cloud.NotFound)).toMatchObject({ resource: "cursor" })
        }

        expect(yield* get("/jobs", Cloud.JobsSummary)).toEqual({
          queued: 1,
          running: null,
          retrying: 1,
          dead: 3,
          byType: [
            { jobName: "Later", done: null, retried: 0, dead: 0, p99Ms: null },
            { jobName: "Retry", done: null, retried: 1, dead: 0, p99Ms: null },
            { jobName: "Settle", done: null, retried: 0, dead: 3, p99Ms: null },
          ],
          throughput: null,
        })

        const deadRows = yield* rows<{
          actor_id: string
          job_id: string
          attempts: number
          cause: string
          dead_at_ms: string
        }>(
          "SELECT actor_id, job_id, attempts::int AS attempts, cause, dead_at_ms::text FROM durable.dead_letters WHERE tenant_id = 'default'",
        )
        const letters = yield* every("/dead-letters?limit=2", Cloud.DeadLetter)
        for (const letter of letters)
          expect(letter.lastError).not.toMatch(/\sat\s|node_modules|\/workspace|\.[cm]?[jt]s:\d/u)
        expect(
          letters.map((letter) => ({
            ...letter,
            since: millis(letter.since),
          })),
        ).toEqual(
          deadRows
            .toSorted(
              (left, right) =>
                Number(right.dead_at_ms) - Number(left.dead_at_ms) ||
                byCodeUnit(left.job_id, right.job_id),
            )
            .map((row) => ({
              id: row.job_id,
              jobName: "Settle",
              jobId: row.job_id,
              actor: `Ledger/${row.actor_id}`,
              attempts: row.attempts,
              lastError: "Unsettled",
              since: Number(row.dead_at_ms),
            })),
        )
        expect(deadRows.map((row) => row.actor_id).toSorted()).toEqual(["a", "a", "b"])

        const runs = yield* rows<{ execution_id: string; workflow: string; started_at_ms: string }>(
          "SELECT execution_id, workflow, started_at_ms::text FROM durable.workflows WHERE tenant_id = 'default'",
        )
        expect(runs.find((run) => run.workflow === "Review")?.execution_id).toBe(executionId)
        const expectedRuns = runs
          .toSorted(
            (left, right) =>
              Number(right.started_at_ms) - Number(left.started_at_ms) ||
              byCodeUnit(left.execution_id, right.execution_id),
          )
          .map((run) => ({
            id: run.execution_id,
            name: run.workflow,
            actor: "Ledger/a",
            step: run.workflow === "Review" ? { index: 2, total: null, name: "cool-off" } : null,
            waitingFor: run.workflow === "Review" ? { kind: "timer", name: "cool-off" } : null,
            startedAt: Number(run.started_at_ms),
            status: { Review: "waiting", Quick: "completed", Doomed: "failed" }[run.workflow],
          }))
        const workflows = (query: string) =>
          every(`/workflows${query}`, Cloud.Workflow).pipe(
            Effect.map((found) =>
              found.map((run) => ({ ...run, startedAt: millis(run.startedAt) })),
            ),
          )
        const only = (name: string) => expectedRuns.filter((run) => run.name === name)
        expect(yield* workflows("?limit=1")).toEqual(expectedRuns)
        expect(yield* workflows("?status=waiting")).toEqual(only("Review"))
        expect(yield* workflows("?status=completed&limit=1")).toEqual(only("Quick"))
        expect(yield* workflows("?status=failed&limit=1")).toEqual(only("Doomed"))
        expect(yield* workflows("?status=running")).toEqual([])

        const [timers] = yield* rows<{ pending: number; due: string }>(
          "SELECT count(*)::int AS pending, min(due_at_ms)::text AS due FROM durable.timers WHERE tenant_id = 'default'",
        )
        expect(timers?.pending).toBeGreaterThanOrEqual(3)
        const firing = yield* get("/timers", Cloud.TimersSummary)
        expect({ ...firing, nextFireAt: millis(firing.nextFireAt) }).toEqual({
          pending: timers?.pending,
          nextFireAt: Number(timers?.due),
        })

        const commands = yield* every("/commands?limit=3", Cloud.CommandLogEntry)
        expect(commands.map((entry) => entry.commandId)).toEqual(
          newestFirst.map((row) => row.command_id),
        )
        expect(
          commands
            .map((entry) => ({ ...entry, at: millis(entry.at) }))
            .find((entry) => entry.commandId === counted.commandId),
        ).toEqual({
          commandId: counted.commandId,
          at: receiptAt(counted.commandId),
          durationMs: receiptDuration(counted.commandId),
          address: "Counter/solo",
          command: "Increment",
          caller: asAlice,
          payloadPreview: null,
          outcome: "ok",
          errorTag: null,
        })
        expect(
          (yield* every("/commands?outcome=error", Cloud.CommandLogEntry)).map((entry) => ({
            ...entry,
            at: millis(entry.at),
          })),
        ).toEqual([
          {
            commandId: refused.commandId,
            at: receiptAt(refused.commandId),
            durationMs: receiptDuration(refused.commandId),
            address: "Ledger/a",
            command: "Refuse",
            caller: asAlice,
            payloadPreview: null,
            outcome: "error",
            errorTag: "Refused",
          },
        ])
        expect(
          (yield* every("/commands?actorType=Counter", Cloud.CommandLogEntry)).map(
            (entry) => entry.commandId,
          ),
        ).toEqual([counted.commandId])
        expect(yield* every("/commands?outcome=replayed", Cloud.CommandLogEntry)).toEqual([])

        const reads = [
          "/overview",
          "/sidebar-counts",
          "/search?q=Ledger",
          "/actor-types",
          "/actor-types/Ledger",
          "/actor-types/Ledger/instances",
          "/actors/Ledger/a",
          "/actors/Ledger/a/receipts",
          "/actors/Ledger/a/events",
          "/actors/Ledger/a/timeline",
          "/commands",
          "/jobs",
          "/dead-letters",
          "/workflows",
          "/timers",
          "/actor-types/Ledger/activity",
          "/actor-types/Ledger/latency?window=1h",
          "/connections",
          "/schedules",
          "/commands/stream",
        ]
        for (const path of reads) {
          const refusedRead = yield* call(`${runtime}${path}`, { cookie: mallory })
          expect([path, refusedRead.status]).toEqual([path, 403])
        }

        const theirs = yield* call("/api/organizations", {
          method: "POST",
          cookie: mallory,
          body: { name: "Elsewhere", slug: `elsewhere-${suffix}` },
        }).pipe(Effect.flatMap((response) => read(response, Cloud.OrganizationMembership)))
        const theirProject = yield* call(`/api/organizations/${theirs.organization.id}/projects`, {
          method: "POST",
          cookie: mallory,
          body: { name: "Elsewhere app", slug: "elsewhere-app", homeRegion: region },
        }).pipe(Effect.flatMap((response) => read(response, Cloud.Project)))
        for (const path of reads) {
          const elsewhere = yield* call(
            `/api/projects/${theirProject.id}/environments/production/runtime${path}`,
            { cookie: mallory },
          )
          expect([path, elsewhere.status]).toEqual([path, 404])
          expect(
            (yield* call(
              `/api/projects/${theirProject.id}/environments/production/runtime${path}`,
              { cookie: alice },
            )).status,
          ).toBe(403)
        }
      }),
    1_500_000,
  )

  it.effect(
    "reports live telemetry of the only runner through the edge: per-type activity and latency, receipt timing, awake actors, placement, feeds, schedules and a redacted command stream, and refuses it to another organization and to a tenant key",
    () =>
      Effect.gen(function* () {
        const images = yield* Images
        const {
          app,
          call,
          origin,
          alice,
          aliceId,
          mallory,
          project,
          deploy,
          settled,
          running,
          sql,
          edgePort,
        } = yield* startStack()

        const deployed = yield* deploy("a", images.v1)
        expect(yield* settled(deployed)).toMatchObject({ status: "live" })
        const [serving] = yield* running(deployed)
        expect(serving).toBeDefined()

        const runtime = `/api/projects/${project.id}/environments/production/runtime`
        yield* poll(
          "the cluster to list no runner but the serving one, so live reads cover the environment",
          120,
          call(`${runtime}/connections`, { cookie: alice }).pipe(
            Effect.map((response) => response.status),
          ),
          (status) => status === 200,
        )
        const client = yield* HttpClient.HttpClient
        const applicationRows = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: app.url, max: 1 })),
          (pool) => Effect.promise(() => pool.end()),
        )
        const rows = <Row extends Record<string, unknown>>(statement: string) =>
          Effect.promise(() => applicationRows.query<Row>(statement)).pipe(
            Effect.map((result) => result.rows),
          )
        const get = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
          call(`${runtime}${path}`, { cookie: alice }).pipe(
            Effect.tap((response) =>
              response.text.pipe(
                Effect.orDie,
                Effect.tap((body) => Effect.sync(() => expect(response.status, body).toBe(200))),
              ),
            ),
            Effect.flatMap((response) => read(response, schema)),
          )
        const millis = (at: DateTime.Utc | null) =>
          at === null ? null : DateTime.toEpochMillis(at)

        const streamed: Array<Cloud.CommandLogEntry> = []
        const opened = yield* client
          .execute(
            HttpClientRequest.get(`${origin}${runtime}/commands/stream`).pipe(
              HttpClientRequest.setHeaders({ origin: apiOrigin, cookie: alice }),
            ),
          )
          .pipe(Effect.orDie)
        expect(opened.status).toBe(200)
        expect(opened.headers["content-type"]).toContain("text/event-stream")
        yield* opened.stream.pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.mapEffect((event) =>
            Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(Cloud.CommandLogEntry)))(
              event.data,
            ),
          ),
          Stream.runForEach((entry) => Effect.sync(() => streamed.push(entry))),
          Effect.ignore,
          Effect.forkScoped,
        )

        const send = (address: string, command: string, payload: Schema.Json) =>
          call(`${runtime}/commands`, {
            method: "POST",
            cookie: alice,
            body: { address, command, payload },
          })
        const sent = (address: string, command: string, payload: Schema.Json) =>
          send(address, command, payload).pipe(
            Effect.tap((response) =>
              response.text.pipe(
                Effect.orDie,
                Effect.tap((body) => Effect.sync(() => expect(response.status, body).toBe(200))),
              ),
            ),
            Effect.flatMap((response) => read(response, Cloud.CommandSent)),
          )

        const five = yield* sent("Ledger/x", "Record", 5)
        const seven = yield* sent("Ledger/x", "Record", 7)
        const noted = yield* sent("Ledger/y", "Note", "hello")
        const refusal = yield* send("Ledger/x", "Refuse", "no")
        expect(refusal.status).toBe(422)
        const refused = yield* read(refusal, Cloud.CommandFailed)
        const configured = yield* sent("Beacon/b1", "Configure", {
          label: "north",
          password: "hunter2-very-secret",
          apiToken: "tok-should-never-leave",
          notes: "n".repeat(50),
        })
        const started = yield* sent("Ticker/t1", "Start", null)
        const mine = [five, seven, noted, configured, started].map((found) => found.commandId)
        mine.push(refused.commandId)

        yield* poll(
          "the console stream to carry every sent command",
          60,
          Effect.sync(() => streamed.length),
          () => mine.every((id) => streamed.some((entry) => entry.commandId === id)),
        )

        const readTiming = () =>
          rows<{
            actor_type: string
            actor_id: string
            command: string
            command_id: string
            started: string
            committed: string
          }>(
            "SELECT actor_type, actor_id, command, command_id, started_at_ms::text AS started, committed_at_ms::text AS committed FROM actor_receipts WHERE tenant_id = 'default'",
          )
        let timing = yield* readTiming()
        const timingOf = (commandId: string) => {
          const row = timing.find((found) => found.command_id === commandId)

          return {
            at: Number(row?.committed),
            durationMs: Number(row?.committed) - Number(row?.started),
          }
        }
        for (const id of mine) {
          const entry = streamed.find((found) => found.commandId === id)!
          const durable = timingOf(id)
          expect(millis(entry.at)).toBeGreaterThanOrEqual(durable.at)
          expect(entry.durationMs).toBeGreaterThanOrEqual(durable.durationMs)
          expect(entry.caller).toEqual({ kind: "user", subject: `user:${aliceId}`, source: null })
        }
        const configuredEntry = streamed.find((entry) => entry.commandId === configured.commandId)!
        expect(configuredEntry.address).toBe("Beacon/b1")
        expect(configuredEntry.payloadPreview).toContain('"label":"north"')
        expect(configuredEntry.payloadPreview).toContain('"password":"[redacted]"')
        expect(configuredEntry.payloadPreview).toContain('"apiToken":"[redacted]"')
        expect(configuredEntry.payloadPreview).toContain(`"notes":"${"n".repeat(32)}…"`)
        expect(configuredEntry.payloadPreview).not.toContain("hunter2")
        expect(configuredEntry.payloadPreview).not.toContain("tok-should")
        expect(streamed.find((entry) => entry.commandId === refused.commandId)).toMatchObject({
          outcome: "error",
          errorTag: "Refused",
          payloadPreview: '"no"',
        })
        expect(streamed.find((entry) => entry.commandId === five.commandId)?.payloadPreview).toBe(
          "5",
        )

        const ledgerReceipts = () =>
          rows<{ command: string; count: number; durations: string }>(
            "SELECT command, count(*)::int AS count, string_agg((committed_at_ms - started_at_ms)::text, ',') AS durations FROM actor_receipts WHERE tenant_id = 'default' AND actor_type = 'Ledger' GROUP BY command ORDER BY count(*) DESC, command COLLATE \"C\"",
          )
        const activity = yield* poll(
          "the runner's Ledger activity to count every Ledger receipt",
          60,
          Effect.all([
            get("/actor-types/Ledger/activity?window=1h", Cloud.ActorTypeActivity),
            ledgerReceipts(),
          ]),
          ([found, receipts]) =>
            JSON.stringify(found.commands.map(({ command, count }) => [command, count])) ===
            JSON.stringify(receipts.map(({ command, count }) => [command, count])),
        )
        const [counted, receiptCounts] = activity
        expect(counted.window).toBe("1h")
        expect(counted.series.length).toBeGreaterThanOrEqual(1)
        expect(counted.series.length).toBeLessThanOrEqual(60)
        expect(counted.series.every((point) => point.value >= 0)).toBe(true)
        expect(counted.commands.map((volume) => volume.command)).toEqual(
          expect.arrayContaining(["Record", "Note", "Refuse"]),
        )
        expect(counted.commands.find((volume) => volume.command === "Record")?.count).toBe(
          receiptCounts.find((row) => row.command === "Record")?.count,
        )

        const ledgerCount = receiptCounts.reduce((sum, row) => sum + row.count, 0)
        const durableDurations = receiptCounts
          .flatMap((row) => row.durations.split(",").map(Number))
          .toSorted((left, right) => left - right)
        const latency = yield* get("/actor-types/Ledger/latency?window=1h", Cloud.TurnLatency)
        expect(latency.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(ledgerCount)
        expect(latency.buckets.at(-1)?.upToMs).toBeNull()
        expect(latency.p50Ms).toBeGreaterThanOrEqual(
          durableDurations[Math.ceil(durableDurations.length / 2) - 1] ?? 0,
        )
        expect(latency.p95Ms).toBeGreaterThanOrEqual(latency.p50Ms ?? 0)
        expect(latency.p99Ms).toBeGreaterThanOrEqual(latency.p95Ms ?? 0)
        expect(millis(latency.since)).toBe(millis(counted.since))

        const receipts = yield* get("/actors/Ledger/x/receipts", Cloud.Page(Cloud.Receipt))
        expect(
          receipts.items
            .filter((receipt) => mine.includes(receipt.commandId))
            .map((receipt) => [receipt.commandId, millis(receipt.at)])
            .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
        ).toEqual(
          [five.commandId, seven.commandId, refused.commandId]
            .map((id) => [id, timingOf(id).at])
            .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
        )
        const log = yield* get("/commands?actorType=Beacon", Cloud.Page(Cloud.CommandLogEntry))
        expect(
          log.items
            .filter((entry) => entry.commandId === configured.commandId)
            .map((entry) => ({ ...entry, at: millis(entry.at) })),
        ).toEqual([
          {
            commandId: configured.commandId,
            ...timingOf(configured.commandId),
            address: "Beacon/b1",
            command: "Configure",
            caller: { kind: "user", subject: `user:${aliceId}`, source: null },
            payloadPreview: null,
            outcome: "ok",
            errorTag: null,
          },
        ])

        yield* sent("Ledger/x", "Note", "touch-x")
        yield* sent("Ledger/y", "Note", "touch-y")
        yield* sent("Beacon/b1", "Configure", {
          label: "touch",
          password: "p",
          apiToken: "t",
          notes: "n",
        })
        timing = yield* readTiming()
        const newest = (actorType: string, actorId: string) =>
          timing
            .filter((row) => row.actor_type === actorType && row.actor_id === actorId)
            .toSorted((left, right) => Number(right.committed) - Number(left.committed))[0]
        const generations = yield* rows<{ actor_id: string; generation: number }>(
          "SELECT actor_id, generation::int AS generation FROM durable.actors WHERE tenant_id = 'default' AND actor_type = 'Ledger'",
        )
        const instances = yield* get(
          "/actor-types/Ledger/instances",
          Cloud.Page(Cloud.ActorInstance),
        )
        expect(
          instances.items.map((instance) => ({
            ...instance,
            lastActivityAt: millis(instance.lastActivityAt),
          })),
        ).toEqual(
          ["x", "y"].map((key) => ({
            key,
            status: "awake",
            lastCommand: newest("Ledger", key)?.command,
            lastActivityAt: Number(newest("Ledger", key)?.committed),
            generation: generations.find((row) => row.actor_id === key)?.generation,
          })),
        )

        const tenantKey = `dak_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`
        yield* sql(
          "INSERT INTO hosted_api_key (key_hash, deployment_id, tenant, subject) VALUES ($1, $2, 'default', 'tenant-app-user')",
          [new Bun.CryptoHasher("sha256").update(tenantKey).digest("hex"), deployed],
        )
        const edgeOrigin = `http://127.0.0.1:${edgePort}`
        const asTenant = {
          host: `${project.id.replaceAll("_", "-")}-production.localhost`,
          authorization: `Bearer ${tenantKey}`,
        }
        const feed = yield* client
          .execute(
            HttpClientRequest.get(`${edgeOrigin}/actors/Beacon/b1/events?event=Signaled`).pipe(
              HttpClientRequest.setHeaders(asTenant),
            ),
          )
          .pipe(Effect.orDie)
        expect(feed.status).toBe(200)
        yield* feed.stream.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped)

        const connections = yield* poll(
          "the runner to count the open feed",
          30,
          get("/connections", Cloud.ConnectionsSummary),
          (found) => found.feedSubscribers === 1,
        )
        expect(connections).toEqual({
          open: 1,
          parked: null,
          sseStreams: 1,
          feedSubscribers: 1,
          replayGaps: null,
          openVersusParked: null,
          byActorType: [{ actorType: "Beacon", open: 1, parked: null, sse: 1 }],
        })

        const beacon = yield* get("/actors/Beacon/b1", Cloud.ActorInspector)
        expect(beacon.events.map((event) => [event.name, event.subscribers])).toEqual([
          ["Signaled", 1],
        ])
        expect(beacon.connections.sockets).toBe(0)
        expect(beacon.properties).toMatchObject({
          status: "awake",
          runner: serving,
          region,
          mailboxDepth: 0,
          tenant: "default",
        })

        const overview = yield* get("/overview", Cloud.Overview)
        expect(overview.actors).toEqual({ awake: 4, total: 4 })
        expect(overview.health.maxMailbox).toEqual({ depth: 0, actor: null })
        expect(overview.commands?.perSecond).toBeGreaterThan(0)
        expect(overview.commands?.p50Ms).toBeGreaterThanOrEqual(0)
        const types = yield* get("/actor-types", Schema.Array(Cloud.ActorTypeSummary))
        expect(
          types.map((type) => [type.name, type.instances, type.awake, type.maxMailbox]),
        ).toEqual([
          ["Beacon", 1, 1, 0],
          ["Ledger", 2, 2, 0],
          ["Ticker", 1, 1, 0],
        ])
        expect(types.every((type) => (type.commandsPerSecond ?? 0) > 0)).toBe(true)

        const pulses = rows<{
          command_id: string
          committed: string
          duration: string
          outcome_tag: string
        }>(
          "SELECT command_id, committed_at_ms::text AS committed, (committed_at_ms - started_at_ms)::text AS duration, outcome::jsonb ->> '_tag' AS outcome_tag FROM actor_receipts WHERE tenant_id = 'default' AND actor_type = 'Ticker' AND command = 'Pulse' ORDER BY committed_at_ms DESC, command_id COLLATE \"C\" DESC LIMIT 1",
        )
        const due = rows<{ due: string }>(
          "SELECT min(due_at_ms)::text AS due FROM actor_outbox WHERE tenant_id = 'default' AND actor_type = 'Ticker' AND timer_key LIKE '$cron:%'",
        )
        const expectedSchedule = Effect.gen(function* () {
          const [tick] = yield* pulses
          const [next] = yield* due

          return [
            {
              name: "Pulse",
              actorPattern: "Ticker/*",
              cron: "@every 5000ms",
              lastRun:
                tick === undefined
                  ? null
                  : {
                      at: Number(tick.committed),
                      outcome: tick.outcome_tag === "Success" ? "ok" : "error",
                      durationMs: Number(tick.duration),
                    },
              nextRunAt: next?.due == null ? null : Number(next.due),
            },
          ]
        })
        const listedSchedules = get("/schedules", Schema.Array(Cloud.Schedule)).pipe(
          Effect.map((found) =>
            found.map((schedule) => ({
              ...schedule,
              lastRun:
                schedule.lastRun === null
                  ? null
                  : { ...schedule.lastRun, at: millis(schedule.lastRun.at) },
              nextRunAt: millis(schedule.nextRunAt),
            })),
          ),
        )
        const agreeing = Effect.all([expectedSchedule, listedSchedules, expectedSchedule]).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: ([first, found, last]) =>
              first[0]?.lastRun !== null &&
              JSON.stringify(first) === JSON.stringify(last) &&
              JSON.stringify(found) === JSON.stringify(first),
            times: 120,
          }),
        )
        const [before, listed, after] = yield* agreeing
        expect(before[0]?.lastRun).not.toBeNull()
        expect(listed).toEqual(before)
        expect(listed).toEqual(after)
        expect(listed[0]?.lastRun?.outcome).toBe("ok")

        for (const path of [
          "/actor-types/Ledger/activity",
          "/actor-types/Ledger/latency",
          "/connections",
          "/schedules",
          "/commands/stream",
          "/actors/Beacon/b1",
        ])
          expect([path, (yield* call(`${runtime}${path}`, { cookie: mallory })).status]).toEqual([
            path,
            403,
          ])

        for (const path of [
          "/inspector/live/overview",
          "/inspector/live/activity?type=Ledger",
          "/inspector/commands/stream",
          "/inspector/schedules",
        ]) {
          const refusedByEdge = yield* client
            .execute(
              HttpClientRequest.get(`${edgeOrigin}${path}`).pipe(
                HttpClientRequest.setHeaders(asTenant),
              ),
            )
            .pipe(Effect.orDie)
          expect([path, refusedByEdge.status]).toEqual([path, 501])
          expect(
            (yield* read(
              refusedByEdge,
              Schema.Struct({ reason: Schema.Struct({ _tag: Schema.String }) }),
            )).reason._tag,
          ).toBe("UnsupportedBillingRoute")
        }
      }).pipe(Effect.scoped),
    1_500_000,
  )

  it.effect(
    "builds every new deployment locally, labels a redeploy of a rollback by its original commit, and serves each built image",
    () =>
      Effect.gen(function* () {
        const {
          owned,
          sql,
          call,
          alice,
          aliceId,
          deployments,
          commit,
          detail,
          settled,
          send,
          statusOf,
        } = yield* startStack({ context: repository, dockerfile: "infra/local/runner/Dockerfile" })

        const recorded = (response: HttpClientResponse.HttpClientResponse) =>
          Effect.gen(function* () {
            const body = yield* response.text.pipe(Effect.orDie)
            expect(response.status, body).toBe(200)
            const found = yield* read(response, Cloud.DeploymentDetail)
            yield* Ref.update(owned, (ids) => [...ids, found.id])

            return found
          })
        const create = (seed: string, message: string) =>
          call(deployments, {
            method: "POST",
            cookie: alice,
            body: { environment: "production", commitSha: commit(seed), message },
          }).pipe(Effect.flatMap(recorded))
        const steps = (id: string) =>
          detail(id).pipe(
            Effect.map((found) => found.steps.map((step) => `${step.name}:${step.status}`)),
          )
        const built = ["build:succeeded", "migrate:succeeded", "start-runners:succeeded"]
        const finished = (id: string) =>
          poll(`deployment ${id}'s steps to finish`, 120, steps(id), (found) =>
            found.every((step) => !step.endsWith(":running")),
          )

        const first = yield* create("a", "Counter v1")
        const imageOf = (id: string) =>
          sql<{ image: string }>("SELECT image FROM deployment WHERE id = $1", [id]).pipe(
            Effect.map((rows) => rows[0]?.image),
          )
        expect(first.status).toBe("in-progress")
        expect(first.steps[0]).toMatchObject({ name: "build", status: "running" })
        expect(yield* settled(first.id)).toMatchObject({ status: "live", message: "Counter v1" })
        expect(yield* imageOf(first.id)).toMatch(/^sha256:[0-9a-f]{64}$/u)
        expect(yield* steps(first.id)).toEqual([...built, "drain-previous:skipped"])
        const log = yield* call(`${deployments}/${first.id}/build-log`, { cookie: alice }).pipe(
          Effect.flatMap((response) => read(response, Cloud.BuildLog)),
        )
        expect(log.complete).toBe(true)
        expect(log.lines.some((line) => line.text.includes("infra/local/runner"))).toBe(true)
        expect((yield* send(2)).result).toMatchObject({
          count: 2,
          version: "aaaaaaa",
          caller: `user:${aliceId}`,
        })

        const second = yield* create("b", "Counter v2")
        expect(yield* settled(second.id)).toMatchObject({ status: "live" })
        expect(yield* finished(second.id)).toEqual([...built, "drain-previous:succeeded"])
        expect((yield* send(1)).result).toMatchObject({ count: 3, version: "bbbbbbb" })

        const rolledBack = yield* call(`${deployments}/${first.id}/rollback`, {
          method: "POST",
          cookie: alice,
        }).pipe(Effect.flatMap(recorded))
        expect(rolledBack).toMatchObject({
          message: "Rollback to aaaaaaa: Counter v1",
          rolledBackFrom: first.id,
        })
        expect(yield* settled(rolledBack.id)).toMatchObject({ status: "live" })
        expect((yield* steps(rolledBack.id)).slice(0, 2)).toEqual([
          "build:skipped",
          "migrate:skipped",
        ])
        expect(yield* statusOf(second.id)).toBe("rolled-back")
        expect((yield* send(1)).result).toMatchObject({ count: 4, version: "aaaaaaa" })

        const redeployed = yield* call(`${deployments}/${rolledBack.id}/redeploy`, {
          method: "POST",
          cookie: alice,
        }).pipe(Effect.flatMap(recorded))
        expect(redeployed).toMatchObject({
          commitSha: commit("a"),
          message: "Redeploy aaaaaaa: Counter v1",
          rolledBackFrom: null,
        })
        expect(redeployed.steps[0]).toMatchObject({ name: "build", status: "running" })
        expect(yield* settled(redeployed.id)).toMatchObject({ status: "live" })
        expect(yield* finished(redeployed.id)).toEqual([...built, "drain-previous:succeeded"])
        expect(yield* imageOf(redeployed.id)).toMatch(/^sha256:[0-9a-f]{64}$/u)
        expect(yield* statusOf(rolledBack.id)).toBe("drained")
        expect((yield* send(1)).result).toMatchObject({
          count: 5,
          version: "aaaaaaa",
          caller: `user:${aliceId}`,
        })

        const again = yield* call(`${deployments}/${redeployed.id}/redeploy`, {
          method: "POST",
          cookie: alice,
        }).pipe(Effect.flatMap(recorded))
        expect(again.message).toBe("Redeploy aaaaaaa: Counter v1")
        expect(yield* settled(again.id)).toMatchObject({ status: "live" })
      }),
    1_500_000,
  )
})
