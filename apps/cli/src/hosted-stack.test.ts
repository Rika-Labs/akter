import * as Cloud from "@akter/cloud-api"
import { edgeKey } from "@rikalabs/akter/testing"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  Crypto,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
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
} from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { PlatformError } from "effect/PlatformError"
import { Pool } from "pg"
import { packContext } from "./commands/cloud/archive.ts"
import { runCliWith, startCliWith } from "./testing.ts"

/**
 * `akter login`, `whoami`, `deploy` and `logout` against the documented
 * Docker Compose stack, `infra/local/compose.yaml` under its own project name
 * and free ports, whose API builds deployments itself.
 *
 * The login is approved the way a person would approve it, by a signed-in
 * session claiming and approving the code the CLI printed. The deploy uploads
 * a copy of the example runner's build context holding a marker file the
 * API's own mounted source does not have, so the live image proves it was
 * built from the upload. A command sent with the CLI's stored session must
 * reach the counter as the person who logged in.
 *
 * The Compose project with its volumes and built images, the runner and
 * migration containers of the deployment, and the image built for it are the
 * only Docker objects it creates and removes.
 */
const repository = new URL("../../../", import.meta.url).pathname
const composeFile = "infra/local/compose.yaml"
const password = "correct-horse-battery-staple-42"
const dockerfile = "infra/local/runner/Dockerfile"
const marker = "infra/local/runner/deploy-marker.txt"

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

/** A Compose project of the documented local stack, brought down with the scope. */
const composeStack = Effect.gen(function* () {
  const id = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
  const project = `akter-cli-${id}`
  const ports = {
    pg: yield* freePort,
    api: yield* freePort,
    edge: yield* freePort,
    outbox: yield* freePort,
  }
  const signing = yield* edgeKey(`local-cli-${id}`)
  const jwk = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", signing.privateKey))
  const env = {
    COMPOSE_PROJECT_NAME: project,
    CONTROL_PLANE_PG_PORT: String(ports.pg),
    API_HTTP_PORT: String(ports.api),
    EDGE_HTTP_PORT: String(ports.edge),
    OUTBOX_HTTP_PORT: String(ports.outbox),
    API_ORIGIN: `http://localhost:${ports.api}`,
    EDGE_SIGNING_KEYS: yield* encodeJson([
      { kid: `local-cli-${id}`, x: jwk.x ?? "", d: jwk.d ?? "" },
    ]).pipe(Effect.orDie),
    EDGE_PUBLICATION_LEAD: "0 seconds",
  }

  const compose = (...args: ReadonlyArray<string>) =>
    run("docker", ["compose", "-p", project, "-f", composeFile, ...args], env)

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

  return { compose, ports, pool, origin: env.API_ORIGIN }
})

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)

layer(services, { excludeTestServices: true, timeout: Duration.minutes(30) })(
  "akter login and deploy on the documented Compose stack",
  (it) => {
    it.effect(
      "logs in through the device grant, deploys an uploaded context to live, and sends a command as the person who logged in",
      () =>
        Effect.gen(function* () {
          const stack = yield* composeStack
          const fs = yield* FileSystem.FileSystem
          const client = yield* HttpClient.HttpClient
          const api = `http://127.0.0.1:${stack.ports.api}`

          const sql = <Row extends Record<string, unknown>>(
            statement: string,
            values: ReadonlyArray<string | number> = [],
          ) =>
            Effect.promise(() => stack.pool.query<Row>(statement, [...values])).pipe(
              Effect.map((result) => result.rows),
            )

          const call = (
            path: string,
            init: {
              readonly method?: "GET" | "POST"
              readonly body?: Schema.Json
              readonly cookie?: string
              readonly bearer?: string
            } = {},
          ) =>
            Effect.gen(function* () {
              let request = HttpClientRequest.make(init.method ?? "GET")(`${api}${path}`).pipe(
                HttpClientRequest.setHeaders({ origin: stack.origin }),
              )

              if (init.cookie !== undefined)
                request = HttpClientRequest.setHeader(request, "cookie", init.cookie)
              if (init.bearer !== undefined)
                request = HttpClientRequest.bearerToken(request, init.bearer)
              if (init.body !== undefined)
                request = yield* HttpClientRequest.bodyJson(init.body)(request).pipe(Effect.orDie)

              return yield* client
                .execute(request)
                .pipe(
                  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
                  Effect.orDie,
                  Effect.flatMap(replyOf),
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
          const email = `cli-${suffix}@example.com`

          expect(
            (yield* call("/auth/sign-up/email", {
              method: "POST",
              body: { name: "Ada", email, password },
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

          const signIn = yield* call("/auth/sign-in/email", {
            method: "POST",
            body: { email, password },
          })

          expect(signIn.status).toBe(200)

          const cookie = Cookies.toCookieHeader(signIn.cookies)
          const me = yield* ok(Cloud.Me, "/api/me", { cookie })
          const membership = yield* ok(Cloud.OrganizationMembership, "/api/organizations", {
            method: "POST",
            cookie,
            body: { name: "CLI", slug: `cli-${suffix}` },
          })
          const project = yield* ok(
            Cloud.Project,
            `/api/organizations/${membership.organization.id}/projects`,
            {
              method: "POST",
              cookie,
              body: { name: "Counter app", slug: "counter-app", homeRegion: "us-east-1" },
            },
          )

          const config = `${yield* fs.makeTempDirectoryScoped()}/akter`
          const cli = (options: { readonly env?: Record<string, string> } = {}) => ({
            env: { AKTER_CONFIG_DIR: config, ...options.env },
          })

          const login = yield* startCliWith(cli())(["login", "--api-url", api])
          const printed = yield* poll(
            "the CLI to print its sign-in code",
            30,
            Effect.sync(() => login.printed.stdout),
            (stdout) => stdout.includes("enter the code "),
          )
          const userCode = /enter the code ([A-Z0-9]{4}-[A-Z0-9]{4})\./u.exec(printed)?.[1] ?? ""

          expect(printed).toMatch(/open http:\/\/localhost:\d+\/device\n/u)
          expect(printed).not.toContain("user_code=")
          expect(
            (yield* call(`/auth/device?user_code=${encodeURIComponent(userCode)}`, { cookie }))
              .status,
          ).toBe(200)
          expect(
            (yield* call("/auth/device/approve", {
              method: "POST",
              cookie,
              body: { userCode },
            })).status,
          ).toBe(200)

          const loggedIn = yield* Fiber.join(login.fiber)

          expect(Exit.isSuccess(loggedIn), login.printed.stderr).toBe(true)
          expect(login.printed.stdout).toContain(`Logged in to ${api} as ${email}`)

          const stored = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
          )(yield* fs.readFileString(`${config}/credentials.json`)).pipe(Effect.orDie)

          expect(((yield* fs.stat(`${config}/credentials.json`)).mode & 0o777).toString(8)).toBe(
            "600",
          )

          const whoami = yield* runCliWith(cli())(["whoami"])

          expect(whoami.exitCode, whoami.stderr).toBe(0)
          expect(whoami.stdout).toContain(`${email} at ${api}`)
          expect(whoami.stdout).toContain(`cli-${suffix}  owner  ${membership.organization.id}`)

          const context = yield* fs.makeTempDirectoryScoped()
          const packed = yield* packContext({ context: repository, dockerfile })

          yield* Effect.promise(() => new Bun.Archive(packed.archive).extract(context))
          yield* fs.writeFileString(`${context}/${marker}`, `uploaded ${suffix}`)

          const deploy = yield* runCliWith(cli())([
            "deploy",
            "--project",
            project.id,
            "--env",
            "production",
            "--context",
            context,
            "--dockerfile",
            dockerfile,
          ])

          const deployments = yield* ok(
            Cloud.Page(Cloud.DeploymentSummary),
            `/api/projects/${project.id}/deployments`,
            { cookie },
          )
          const deployment = deployments.items[0]

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const filter of [
                `label=akter.deployment=${deployment?.id ?? "none"}`,
                `ancestor=akter-build:${deployment?.id ?? "none"}`,
              ]) {
                const containers = yield* run("docker", ["ps", "-aq", "--filter", filter])

                for (const container of containers.out.split("\n").filter(Boolean))
                  yield* run("docker", ["rm", "-f", container])
              }

              yield* run("docker", ["image", "rm", "--force", `akter-build:${deployment?.id}`])
            }),
          )

          if (deploy.exitCode !== 0) {
            const logs = yield* stack.compose("logs", "--tail", "120", "api")

            expect(
              deploy.exitCode,
              `${deploy.stdout}\n${deploy.stderr}\n${logs.out.slice(-8000)}`,
            ).toBe(0)
          }

          expect(deployments.items).toHaveLength(1)
          expect(deployment?.status).toBe("live")
          expect(deployment?.commitSha).toMatch(/^[0-9a-f]{40}$/u)
          expect(deploy.stdout).toContain(`Deployment ${deployment?.id} is live in production`)

          const [registered] = yield* sql<{ image: string }>(
            "SELECT image FROM deployment WHERE id = $1",
            [deployment?.id ?? ""],
          )
          const shipped = yield* run("docker", [
            "run",
            "--rm",
            "--entrypoint",
            "cat",
            registered?.image ?? "",
            `/workspace/${marker}`,
          ])

          expect(shipped.out, shipped.err).toBe(`uploaded ${suffix}`)

          const sent = yield* ok(
            Cloud.CommandSent,
            `/api/projects/${project.id}/environments/production/runtime/commands`,
            {
              method: "POST",
              bearer: stored.token,
              body: {
                address: "Counter/hits",
                command: "Increment",
                payload: 3,
                commandId: (yield* (yield* Crypto.Crypto).randomUUIDv4).toString(),
              },
            },
          )

          expect(sent.replayed).toBe(false)
          expect(sent.result).toMatchObject({
            count: 3,
            version: deployment?.commitSha.slice(0, 7),
            caller: `user:${me.user?.id}`,
          })

          const logout = yield* runCliWith(cli())(["logout"])

          expect(logout.stdout).toBe(`Logged out of ${api}.\n`)
          expect((yield* call("/api/me", { bearer: stored.token })).status).toBe(401)
          expect(yield* runCliWith(cli())(["whoami"])).toMatchObject({
            exitCode: 2,
            reason: "NotLoggedIn",
          })
        }).pipe(Effect.scoped),
      1_800_000,
    )
  },
)
